const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const mail = require('./mail');

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
    tls: { rejectUnauthorized: false },
    mailbox: imap.mailbox || 'INBOX',
    senderFilter: imap.sender_filter || '',
    pollIntervalMs: imap.poll_interval_ms ?? 5000,
  };
}

/**
 * One IMAP connection shared by every task that uses the same account. It polls
 * the mailbox on an interval, extracts all verification tokens from new mails and
 * routes them to the right address via the JWT payload's email. This replaces the
 * previous "one connection per task" model, which does not survive hundreds of
 * concurrent signups against a single mailbox.
 */
class MailboxWatcher {
  constructor(cfg, onWarn) {
    this.cfg = cfg;
    this.onWarn = onWarn || (() => {});
    this.tokens = new Map(); // email -> { token, date }
    this.seen = new Set();   // processed UIDs
    this.waiters = [];       // { email, since, start, deadline, resolve, reject }
    this.client = null;
    this.starting = null;
    this.timer = null;
    this.stopped = false;
    this.startedAt = new Date();
  }

  ensureStarted() {
    if (!this.starting) {
      this.starting = (async () => {
        const client = new ImapFlow({
          host: this.cfg.host,
          port: this.cfg.port,
          secure: this.cfg.secure,
          auth: this.cfg.auth,
          tls: this.cfg.tls,
          logger: false,
        });
        await client.connect();
        this.client = client;
        this.schedule(0);
      })();
    }
    return this.starting;
  }

  schedule(delay) {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.tick(), delay);
  }

  async tick() {
    try {
      await this.scan();
    } catch (err) {
      this.onWarn(`imap watcher: ${err.message}`);
    }
    this.checkWaiters();
    this.schedule(this.cfg.pollIntervalMs);
  }

  async scan() {
    const lock = await this.client.getMailboxLock(this.cfg.mailbox);
    try {
      // IMAP SINCE is date-only; the 2-minute back-off just guards clock skew.
      const since = new Date(this.startedAt.getTime() - 2 * 60 * 1000);
      const uids = await this.client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) return;

      for (const uid of uids) {
        if (this.seen.has(uid)) continue;
        this.seen.add(uid);

        const msg = await this.client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg) continue;

        const parsed = await simpleParser(msg.source);
        if (this.cfg.senderFilter) {
          const from = (parsed.from?.text || '').toLowerCase();
          if (!from.includes(this.cfg.senderFilter.toLowerCase())) continue;
        }

        const body = [parsed.html, parsed.text, parsed.subject].filter(Boolean).join(' ');
        const date = parsed.date || new Date();
        for (const { token, email } of mail.extractAllTokens(body)) {
          if (!email) continue;
          const prev = this.tokens.get(email);
          if (!prev || date >= prev.date) this.tokens.set(email, { token, date });
        }
      }
    } finally {
      lock.release();
    }
  }

  checkWaiters() {
    if (this.waiters.length === 0) return;
    const now = Date.now();
    this.waiters = this.waiters.filter(w => {
      const hit = this.tokens.get(w.email);
      if (hit && hit.date.getTime() >= w.since - 1000) {
        w.resolve(hit.token);
        return false;
      }
      if (now >= w.deadline) {
        w.reject(new Error(`No verification link received within ${Math.round((w.deadline - w.start) / 1000)}s`));
        return false;
      }
      return true;
    });
  }

  waitForToken(email, since, timeout) {
    const key = email.toLowerCase();
    const hit = this.tokens.get(key);
    if (hit && hit.date.getTime() >= since.getTime() - 1000) {
      return Promise.resolve(hit.token);
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({
        email: key,
        since: since.getTime(),
        start: Date.now(),
        deadline: Date.now() + timeout,
        resolve,
        reject,
      });
    });
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.waiters) w.reject(new Error('Mailbox watcher stopped'));
    this.waiters = [];
    if (this.client) {
      await this.client.logout().catch(() => {});
      this.client = null;
    }
  }
}

const registry = new Map();

function keyFor(cfg) {
  return `${cfg.host}|${cfg.auth.user}|${cfg.mailbox}`;
}

/**
 * Waits for the verification token for `email`, sharing one connection per
 * account. The watcher is created on first use and reused by later tasks.
 */
async function waitForToken(imap, { email, since, overrides = {}, timeout, onWarn }) {
  const cfg = buildImapConfig(imap, overrides);
  const key = keyFor(cfg);

  let watcher = registry.get(key);
  if (!watcher) {
    watcher = new MailboxWatcher(cfg, onWarn);
    registry.set(key, watcher);
  }

  await watcher.ensureStarted();
  return watcher.waitForToken(email, since, timeout ?? (imap.wait_timeout_ms ?? 180000));
}

async function closeAll() {
  for (const watcher of registry.values()) await watcher.stop();
  registry.clear();
}

module.exports = { waitForToken, closeAll };
