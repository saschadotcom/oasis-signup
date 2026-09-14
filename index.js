const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const http = require('./lib/http');
const capsolver = require('./lib/capsolver');
const mail = require('./lib/mail');
const geo = require('./lib/geo');
const oasis = require('./lib/oasis');
const log = require('./lib/logger');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
}

function loadProxies() {
  const file = path.join(__dirname, 'proxies.txt');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(line => {
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

    const emailToken = await mail.waitForToken(config.imap, {
      email,
      since,
      overrides: imapOverrides(row),
      onPoll: (attempt) => {
        if (attempt % 6 === 1) log.info(`[${email}] Waiting for verification link…`);
      },
    });
    log.success(`[${email}] Verification link received`);

    await sleep(stepDelay);

    const sessionToken = await oasis.checkVerification(session, config, emailToken);
    log.success(`[${email}] Email verified`);

    await sleep(stepDelay);

    log.info(`[${email}] Solving reCAPTCHA (${config.recaptcha.site_key})`);
    const captcha = await capsolver.solveRecaptcha({
      websiteURL: config.recaptcha.page_url || config.return_url,
      websiteKey: config.recaptcha.site_key,
      action: config.recaptcha.action,
      enterprise: config.recaptcha.enterprise !== false,
      proxy: session.capsolverProxy,
    });
    log.success(`[${email}] reCAPTCHA token received`);

    await sleep(stepDelay);

    const polls = oasis.buildPollAnswers(config);
    log.info(`[${email}] Cities (ranked): ${polls.chosen.join(' > ')}`);

    await oasis.confirm(session, config, { token: sessionToken, captcha, location, ip, profile, polls });
    log.success(`[${email}] Registered for ${config.channel_name}`);
  } finally {
    await session.close();
  }
}

async function runTaskWithRetries(row, proxies, proxyIndex, config) {
  const attempts = Math.max(1, config.retries_per_task ?? 1);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Cloudflare hands out the occasional 403 regardless of fingerprint, so a
    // retry moves to the next proxy instead of hammering the same IP.
    const proxy = proxies.length > 0
      ? proxies[(proxyIndex + attempt - 1) % proxies.length]
      : null;

    try {
      await runTask(row, proxy, config);
      return;
    } catch (err) {
      const detail = err.body ? `${err.message} :: ${err.body}` : err.message;
      log.error(`[${row['Email']}] Attempt ${attempt}/${attempts} failed: ${detail}`);
      if (attempt < attempts) await sleep(config.retry_delay_ms ?? 5000);
    }
  }
}

async function runQueue(taskFns, maxConcurrent, delayMs) {
  const active = new Set();
  for (let i = 0; i < taskFns.length; i++) {
    if (i > 0) await sleep(delayMs);
    while (active.size >= maxConcurrent) {
      await Promise.race(active);
    }
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
  const tasks = loadTasks();

  if (tasks.length === 0) {
    log.warn('No valid tasks found in input.csv');
    return;
  }

  log.info(`Log file: ${log.file}`);

  try {
    log.info(`CapSolver balance: $${await capsolver.getBalance()}`);
  } catch (err) {
    log.warn(`Could not read CapSolver balance: ${err.message}`);
  }

  const maxConcurrent = config.max_concurrent_tasks ?? 2;
  const delayBetween = config.delay_between_tasks_ms ?? 3000;

  log.info(`Tasks: ${tasks.length} | Proxies: ${proxies.length} | Concurrent: ${maxConcurrent} | Delay: ${delayBetween}ms`);
  if (proxies.length === 0) log.warn('No proxies loaded – running without proxy');

  const taskFns = tasks.map((row, i) => () => runTaskWithRetries(row, proxies, i, config));

  await http.initTLS();
  try {
    await runQueue(taskFns, maxConcurrent, delayBetween);
  } finally {
    await http.destroyTLS();
  }
  log.info('All tasks finished');
}

main().catch(err => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
