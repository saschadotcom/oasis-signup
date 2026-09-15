const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const http = require('./lib/http');
const capsolver = require('./lib/capsolver');
const mailbox = require('./lib/mailbox');
const geo = require('./lib/geo');
const oasis = require('./lib/oasis');
const { ProxyPool } = require('./lib/proxies');
const log = require('./lib/logger');

const RESULTS_FILE = path.join(__dirname, 'results.csv');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
}

// Sentinel lines that mean "use the local/direct connection, no proxy". Handy
// for mixing a direct connection into the rotation or running fully direct
// without emptying proxies.txt. A real local proxy (e.g. localhost:8080) still
// works because it carries a port and won't match these bare keywords.
const DIRECT_PROXY = new Set(['localhost', 'local', 'direct', 'none', 'no-proxy']);

function loadProxies() {
  const file = path.join(__dirname, 'proxies.txt');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(line => {
      if (DIRECT_PROXY.has(line.toLowerCase())) return null; // direct connection
      const parts = line.split(':');
      return { host: parts[0], port: parts[1], user: parts[2] || '', pass: parts[3] || '' };
    });
}

function loadTasks() {
  const file = path.join(__dirname, 'input.csv');
  const rows = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true, trim: true });
  return rows.filter(row => {
    if (!row['Email']) {
      log.warn('Skipping row – missing Email');
      return false;
    }
    return true;
  });
}

// Addresses already registered in a previous run, so a restart resumes instead
// of re-submitting (and re-paying CapSolver) for everyone.
function loadCompleted() {
  const done = new Set();
  if (!fs.existsSync(RESULTS_FILE)) return done;
  try {
    const rows = parse(fs.readFileSync(RESULTS_FILE, 'utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_quotes: true,
    });
    for (const r of rows) {
      if ((r.status || '').toLowerCase() === 'success') done.add((r.email || '').toLowerCase());
    }
  } catch (err) {
    log.warn(`Could not read ${path.basename(RESULTS_FILE)}: ${err.message}`);
  }
  return done;
}

function csvField(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function recordResult(email, status, detail = '') {
  if (!fs.existsSync(RESULTS_FILE)) fs.writeFileSync(RESULTS_FILE, 'timestamp,email,status,detail\n');
  const fields = [new Date().toISOString(), email, status, String(detail).replace(/[\r\n]+/g, ' ').slice(0, 300)];
  fs.appendFileSync(RESULTS_FILE, fields.map(csvField).join(',') + '\n');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ±40% timing jitter so fixed pauses don't create a machine-regular pattern
// across thousands of signups.
function jitter(base) {
  return Math.round(base * (0.6 + Math.random() * 0.8));
}

// HTTP errors carry `err.status`; thrown network/timeout errors don't.
function isRetryable(err) {
  const s = err.status;
  if (s === undefined || s === null) return true; // network / timeout
  if (s === 0 || s === 403 || s === 408 || s === 429) return true;
  if (s >= 500) return true;
  return false; // other 4xx (e.g. 400 bad data) won't fix itself on retry
}

// Failures worth blaming on the proxy IP (blocked / throttled / dead). Mail and
// CapSolver problems are explicitly excluded so a flaky inbox or solver doesn't
// bench otherwise-healthy proxies (which would snowball into more failures).
function isProxyFault(err) {
  if (err.kind === 'mail') return false;
  if (/^CapSolver/i.test(err.message || '')) return false;
  const s = err.status;
  if (s === undefined || s === null) return true;
  return s === 0 || s === 403 || s === 429 || s >= 500;
}

function isFatalBalance(err) {
  return /balance|insufficient/i.test(err.message || '');
}

function imapOverrides(row) {
  return {
    host: row['Imap Host'] || '',
    port: row['Imap Port'] ? Number(row['Imap Port']) : 0,
    user: row['Imap User'] || '',
    password: row['Imap Password'] || '',
  };
}

function profileFromRow(row) {
  return {
    firstName: row['FirstName'] || '',
    lastName: row['LastName'] || '',
    dateOfBirth: row['DateOfBirth'] || '',
    countryCallingCode: String(row['CountryCallingCode'] || ''),
    nationalPhoneNumber: String(row['PhoneNumber'] || ''),
  };
}

async function runTask(row, proxy, config) {
  const email = row['Email'];
  const profile = profileFromRow(row);
  const stepDelay = config.step_delay_ms ?? 1500;

  const session = http.createSession({
    proxy,
    proxyType: config.proxy_type,
    timeout: config.request_timeout_ms ?? 45000,
  });

  log.info(`[${email}] Starting${proxy ? ` via ${proxy.host}:${proxy.port}` : ' without proxy'} | profile: ${session.profile.name}`);

  try {
    const { ip, location, source } = await geo.lookup(session, config.location, (msg) => log.warn(`[${email}] ${msg}`));
    log.info(`[${email}] Location: ${location.city || '?'}, ${location.countryCode || '?'} (geo: ${source})${ip ? ` | IP: ${ip}` : ''}`);

    const since = new Date(Date.now() - 60 * 1000);
    await oasis.sendVerify(session, config, { email });
    log.success(`[${email}] Verification email requested`);

    log.info(`[${email}] Waiting for verification link…`);
    const emailToken = await mailbox.waitForToken(config.imap, {
      email,
      since,
      overrides: imapOverrides(row),
      timeout: config.imap?.wait_timeout_ms,
      onWarn: (msg) => log.warn(`[${email}] ${msg}`),
      onInfo: (msg) => log.info(`[${email}] ${msg}`),
    });
    log.success(`[${email}] Verification link received`);

    await sleep(jitter(stepDelay));

    const sessionToken = await oasis.checkVerification(session, config, emailToken);
    log.success(`[${email}] Email verified`);

    await sleep(jitter(stepDelay));

    log.info(`[${email}] Solving reCAPTCHA (${config.recaptcha.site_key})`);
    const captcha = await capsolver.solveRecaptcha({
      websiteURL: config.recaptcha.page_url || config.return_url,
      websiteKey: config.recaptcha.site_key,
      action: config.recaptcha.action,
      enterprise: config.recaptcha.enterprise !== false,
      proxy: session.capsolverProxy,
    });
    log.success(`[${email}] reCAPTCHA token received`);

    await sleep(jitter(stepDelay));

    const polls = oasis.buildPollAnswers(config);
    log.info(`[${email}] Cities (ranked): ${polls.chosen.join(' > ')}`);

    await oasis.confirm(session, config, { token: sessionToken, captcha, location, ip, profile, polls });
    log.success(`[${email}] Registered for ${config.channel_name}`);
  } finally {
    await session.close();
  }
}

async function runTaskWithRetries(row, pool, config, state) {
  const email = row['Email'];
  const attempts = Math.max(1, config.retries_per_task ?? 1);
  let lastDetail = '';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (state.abort) return;

    const item = pool.size > 0 ? pool.next() : null;
    const proxy = item ? item.proxy : null;

    try {
      await runTask(row, proxy, config);
      pool.reportSuccess(item);
      recordResult(email, 'success');
      return;
    } catch (err) {
      lastDetail = err.body ? `${err.message} :: ${err.body}` : err.message;
      log.error(`[${email}] Attempt ${attempt}/${attempts} failed: ${lastDetail}`);

      if (isProxyFault(err)) pool.reportFailure(item);

      if (isFatalBalance(err)) {
        state.abort = true;
        state.reason = err.message;
        recordResult(email, 'failed', lastDetail);
        return;
      }

      if (!isRetryable(err)) {
        recordResult(email, 'failed-permanent', lastDetail);
        return;
      }

      if (attempt < attempts) {
        const base = config.retry_delay_ms ?? 5000;
        // Exponential backoff (capped) so we back off, not hammer, on 429/403.
        await sleep(jitter(Math.min(base * 2 ** (attempt - 1), 60000)));
      }
    }
  }

  recordResult(email, 'failed', lastDetail);
}

async function runQueue(taskFns, maxConcurrent, delayMs, state) {
  const active = new Set();
  for (let i = 0; i < taskFns.length; i++) {
    if (state.abort) break;
    if (i > 0) await sleep(jitter(delayMs));
    while (active.size >= maxConcurrent) {
      await Promise.race(active);
    }
    if (state.abort) break;
    const p = taskFns[i]().finally(() => active.delete(p));
    active.add(p);
  }
  await Promise.all(active);
}

async function main() {
  const config = loadConfig();
  capsolver.init(config);

  if (!config.capsolver_api_key) throw new Error('capsolver_api_key missing in config.json');
  if (!config.artist_id) throw new Error('artist_id missing in config.json');
  if (!config.page_id) throw new Error('page_id missing in config.json');
  if (!config.recaptcha?.site_key) throw new Error('recaptcha.site_key missing in config.json');

  const proxies = loadProxies();
  const allTasks = loadTasks();

  if (allTasks.length === 0) {
    log.warn('No valid tasks found in input.csv');
    return;
  }

  const completed = loadCompleted();
  const tasks = allTasks.filter(row => !completed.has(row['Email'].toLowerCase()));
  const skipped = allTasks.length - tasks.length;

  if (tasks.length === 0) {
    log.info(`All ${allTasks.length} tasks already completed (see ${path.basename(RESULTS_FILE)})`);
    return;
  }

  log.info(`Log file: ${log.file}`);

  const minBalance = config.min_balance_usd ?? 1;
  try {
    const balance = await capsolver.getBalance();
    log.info(`CapSolver balance: $${balance}`);
    if (balance < minBalance) {
      throw new Error(`CapSolver balance $${balance} is below the minimum $${minBalance} – aborting`);
    }
  } catch (err) {
    if (/below the minimum/.test(err.message)) throw err;
    log.warn(`Could not read CapSolver balance: ${err.message}`);
  }

  const pool = new ProxyPool(proxies, {
    failureThreshold: config.proxy_failure_threshold ?? 3,
    cooldownMs: config.proxy_cooldown_ms ?? 5 * 60 * 1000,
  });

  const maxConcurrent = config.max_concurrent_tasks ?? 2;
  const delayBetween = config.delay_between_tasks_ms ?? 3000;

  log.info(`Tasks: ${tasks.length}${skipped ? ` (skipped ${skipped} already done)` : ''} | Proxies: ${proxies.length} | Concurrent: ${maxConcurrent}`);
  if (proxies.length === 0) log.warn('No proxies loaded – running without proxy');

  const state = { abort: false, reason: '' };
  const taskFns = tasks.map(row => () => runTaskWithRetries(row, pool, config, state));

  await http.initTLS();
  try {
    await runQueue(taskFns, maxConcurrent, delayBetween, state);
  } finally {
    await mailbox.closeAll();
    await http.destroyTLS();
  }

  if (state.abort) log.error(`Run aborted: ${state.reason}`);
  else log.info('All tasks finished');
}

main().catch(err => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
