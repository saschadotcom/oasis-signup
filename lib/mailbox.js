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
    folders: Array.isArray(imap.folders) ? imap.folders.filter(Boolean) : [],
    scanAllFolders: imap.scan_all_folders !== false,
    excludeFolders: Array.isArray(imap.exclude_folders) ? imap.exclude_folders.filter(Boolean) : [],
    senderFilter: imap.sender_filter || '',
    pollIntervalMs: imap.poll_interval_ms ?? 5000,
  };
}

// Folders that can never hold an incoming verification mail. Everything else —
// Junk/Spam, Trash, Archive, provider-specific and user-created folders — is
// scanned, because spam filters and server-side rules routinely move these
// mails out of the INBOX.
const SKIP_SPECIAL_USE = new Set(['\\Drafts', '\\Sent']);
const SKIP_NAMES = new Set([
  'drafts', 'draft', 'entwürfe', 'entwuerfe',
  'sent', 'sent items', 'sent messages', 'sent mail',
  'gesendet', 'gesendete elemente', 'gesendete objekte',
]);

const FOLDER_REFRESH_MS = 5 * 60 * 1000;
const MAX_FETCH_ATTEMPTS = 5;

// Asks the server which folders exist instead of guessing at provider-specific
// names. Falls back to the configured single mailbox if LIST yields nothing.
async function resolveFolders(client, cfg) {
  if (cfg.folders.length > 0) return cfg.folders;
  if (!cfg.scanAllFolders) return [cfg.mailbox];

  const exclude = new Set(cfg.excludeFolders.map(f => f.toLowerCase()));
  const paths = [];

  for (const box of await client.list()) {
    const flags = box.flags || new Set();
    if (flags.has('\\Noselect') || flags.has('\\NonExistent')) continue;
    if (box.specialUse && SKIP_SPECIAL_USE.has(box.specialUse)) continue;

    const path = box.path;
    const name = (box.name || '').toLowerCase();
    if (SKIP_NAMES.has(name)) continue;
    if (exclude.has(name) || exclude.has(path.toLowerCase())) continue;

    paths.push(path);
  }

  if (paths.length === 0) return [cfg.mailbox];
  // INBOX first: the common case should resolve before we spend time elsewhere.
  return paths.sort((a, b) => (b.toUpperCase() === 'INBOX') - (a.toUpperCase() === 'INBOX'));
}

/**
 * One IMAP connection shared by every task that uses the same account. It polls
 * every relevant folder on an interval, extracts all verification tokens from new
 * mails and routes them to the right address via the JWT payload's email. This
 * replaces the previous "one connection per task" model, which does not survive
 * hundreds of concurrent signups against a single mailbox.
 */
class MailboxWatcher {
  constructor(cfg, onWarn, onInfo) {
    this.cfg = cfg;
    this.onWarn = onWarn || (() => {});
    this.onInfo = onInfo || (() => {});
    this.tokens = new Map();   // email -> { token, date }
    this.seen = new Set();     // processed "folder:uid" keys (UIDs are per-folder)
    this.attempts = new Map(); // "folder:uid" -> failed fetch count
    this.folders = null;
    this.foldersAt = 0;
    this.waiters = [];         // { email, since, start, deadline, resolve, reject }
    this.client = null;
    this.started = false;
    this.timer = null;
    this.stopped = false;
    this.startedAt = new Date();
  }

  ensureStarted() {
    if (!this.started) {
      this.started = true;
      this.tick();
    }
    return Promise.resolve();
  }

  async connect() {
    const client = new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.secure,
      auth: this.cfg.auth,
      tls: this.cfg.tls,
      logger: false,
    });
    // A dropped/reset connection must not silently stall the watcher: null the
    // client on error/close so the next tick reconnects instead of scanning a
    // dead socket (the "mails stop being found after a while" failure mode).
    client.on('error', (err) => this.onWarn(`imap connection: ${err.message}`));
    client.on('close', () => { if (this.client === client) this.client = null; });
    await client.connect();
    this.client = client;
  }

  schedule(delay) {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.tick(), delay);
  }

  async tick() {
    try {
      if (!this.client || this.client.usable === false) await this.connect();
      await this.scan();
    } catch (err) {
      if (!this.stopped) this.onWarn(`imap watcher: ${err.message}`);
      // Drop the (likely broken) connection so the next tick starts fresh.
      try { await this.client?.logout(); } catch { /* ignore */ }
      this.client = null;
    }
    this.checkWaiters();
    this.schedule(this.cfg.pollIntervalMs);
  }

  async ensureFolders() {
    const now = Date.now();
    if (this.folders && now - this.foldersAt < FOLDER_REFRESH_MS) return this.folders;

    const folders = await resolveFolders(this.client, this.cfg);
    this.foldersAt = now;
    if (!this.folders || folders.join('|') !== this.folders.join('|')) {
      this.onInfo(`Watching ${folders.length} IMAP folder(s): ${folders.join(', ')}`);
    }
    this.folders = folders;
    return folders;
  }

  async scan() {
    for (const folder of await this.ensureFolders()) {
      try {
        await this.scanFolder(folder);
      } catch (err) {
        // A folder that cannot be opened (permissions, vanished) must not stop
        // the others, but a dead connection has to bubble up so tick() reconnects.
        if (!this.client || this.client.usable === false) throw err;
        this.onWarn(`imap folder "${folder}": ${err.message}`);
      }
    }
  }

  async scanFolder(folder) {
    const lock = await this.client.getMailboxLock(folder);
    try {
      // IMAP SINCE is date-only; the 2-minute back-off just guards clock skew.
      const since = new Date(this.startedAt.getTime() - 2 * 60 * 1000);
      const uids = await this.client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) return;

      for (const uid of uids) {
        const key = `${folder}:${uid}`;
        if (this.seen.has(key)) continue;

        let parsed;
        try {
          const msg = await this.client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg) throw new Error('message not returned');
          parsed = await simpleParser(msg.source);
        } catch (err) {
          // Leave the key unseen so the next tick retries instead of losing the
          // token for good, but give up eventually to avoid refetching forever.
          const tries = (this.attempts.get(key) || 0) + 1;
          this.attempts.set(key, tries);
          if (tries >= MAX_FETCH_ATTEMPTS) {
            this.seen.add(key);
            this.attempts.delete(key);
            this.onWarn(`imap gave up on ${key} after ${tries} tries: ${err.message}`);
          }
          if (!this.client || this.client.usable === false) throw err;
          continue;
        }

        this.seen.add(key);
        this.attempts.delete(key);

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
        const err = new Error(`No verification link received within ${Math.round((w.deadline - w.start) / 1000)}s`);
        err.kind = 'mail';
        w.reject(err);
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
    for (const w of this.waiters) {
      const err = new Error('Mailbox watcher stopped');
      err.kind = 'mail';
      w.reject(err);
    }
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
async function waitForToken(imap, { email, since, overrides = {}, timeout, onWarn, onInfo }) {
  const cfg = buildImapConfig(imap, overrides);
  const key = keyFor(cfg);

  let watcher = registry.get(key);
  if (!watcher) {
    watcher = new MailboxWatcher(cfg, onWarn, onInfo);
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
