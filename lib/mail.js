const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function decodeJwtPayload(token) {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Oasis mails a magic link (…/registration?token=<JWT>) rather than a numeric
 * code. Links are often wrapped by the mail provider (Outlook safelinks), so the
 * token shows up both URL-encoded (token%3D…) and plain (originalsrc=…). We
 * collect every candidate and, when the recipient is known, prefer the JWT whose
 * payload actually belongs to that address – the right token in a shared inbox.
 */
function extractToken(raw, email) {
  const candidates = new Set();

  for (const m of raw.matchAll(/token=([A-Za-z0-9._-]+)/g)) candidates.add(m[1]);
  for (const m of raw.matchAll(/token%3D([A-Za-z0-9._-]+)/gi)) {
    candidates.add(decodeURIComponent(m[1]));
  }

  const jwts = [...candidates].filter(t => JWT.test(t));
  if (jwts.length === 0) return null;

  if (email) {
    const wanted = email.toLowerCase();
    const match = jwts.find(t => {
      const payload = decodeJwtPayload(t);
      return payload && String(payload.email || '').toLowerCase() === wanted;
    });
    if (match) return match;
  }

  return jwts.sort((a, b) => b.length - a.length)[0];
}

function buildImapConfig(imap, overrides = {}) {
  const host = overrides.host || imap.host;
  const user = overrides.user || imap.user;
  const pass = overrides.password || imap.password;

  if (!host) throw new Error('IMAP host missing (config.imap.host or CSV column "Imap Host")');
  if (!user) throw new Error('IMAP user missing (config.imap.user or CSV column "Imap User")');
  if (!pass) throw new Error('IMAP password missing (config.imap.password or CSV column "Imap Password")');

  return {
    host,
    port: overrides.port || imap.port || 993,
    secure: imap.secure !== false,
    auth: { user, pass },
    logger: false,
    tls: { rejectUnauthorized: false },
  };
}

async function scanMailbox(client, mailbox, { email, since, senderFilter, matchRecipient }) {
  const lock = await client.getMailboxLock(mailbox);
  try {
    const query = { since };
    if (matchRecipient) query.to = email;

    const uids = await client.search(query, { uid: true });
    if (!uids || uids.length === 0) return null;

    // Newest first – the freshest link wins if an address was used before.
    for (const uid of uids.slice(-10).reverse()) {
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!message) continue;

      const parsed = await simpleParser(message.source);
      const from = (parsed.from?.text || '').toLowerCase();
      if (senderFilter && !from.includes(senderFilter.toLowerCase())) continue;

      const body = [parsed.html, parsed.text, parsed.subject].filter(Boolean).join(' ');
      const token = extractToken(body, email);
      if (token) return token;
    }
  } finally {
    lock.release();
  }
  return null;
}

/**
 * Polls the mailbox until the verification link shows up and returns the JWT
 * token from it. `since` should be captured before /verify so an older mail is
 * never reused.
 */
async function waitForToken(imap, { email, since, overrides = {}, onPoll }) {
  const client = new ImapFlow(buildImapConfig(imap, overrides));
  const mailbox = imap.mailbox || 'INBOX';
  const timeout = imap.wait_timeout_ms ?? 180000;
  const interval = imap.poll_interval_ms ?? 5000;
  const deadline = Date.now() + timeout;

  await client.connect();
  try {
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      if (onPoll) onPoll(attempt);

      const token = await scanMailbox(client, mailbox, {
        email,
        since,
        senderFilter: imap.sender_filter,
        matchRecipient: imap.match_recipient === true,
      });
      if (token) return token;

      await sleep(interval);
    }
  } finally {
    await client.logout().catch(() => {});
  }

  throw new Error(`No verification link received within ${Math.round(timeout / 1000)}s`);
}

module.exports = { waitForToken, extractToken };
