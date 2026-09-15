// Browser-driven variant of the signup bot. Instead of replaying the API calls
// it drives a real AdsPower browser profile through the actual registration
// form, so the page produces its own reCAPTCHA Enterprise token (correct action,
// genuine score) and every signup carries a distinct browser fingerprint.
//
// Uses the same config.json, input.csv, proxies.txt and results.csv as index.js.

const puppeteer = require('puppeteer-core');

const tasks = require('./lib/tasks');
const mailbox = require('./lib/mailbox');
const human = require('./lib/human');
const page$ = require('./lib/oasisPage');
const { AdsPower } = require('./lib/adspower');
const { ProxyPool } = require('./lib/proxies');
const log = require('./lib/logger');

const DEFAULT_QUIZ_ANSWER = "(What's the Story) Morning Glory?";

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function rankedVenues(config) {
  const cities = config.polls?.cities;
  if (!cities || !Array.isArray(cities.options) || cities.options.length === 0) {
    throw new Error('config.polls.cities.options is empty – cannot choose cities');
  }
  const pick = Math.max(1, cities.pick || 1);
  return shuffle(cities.options).slice(0, pick).map(c => c.venue);
}

// The location field needs a real place name. A CSV column wins; otherwise it is
// derived from the browser's own public IP so it matches the profile's proxy.
async function detectCity(page) {
  return page.evaluate(async () => {
    const probe = async (url, pick) => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        return pick(await res.json());
      } catch {
        return null;
      }
    };
    return (await probe('https://ipwho.is/', j => (j && j.success !== false ? j.city : null)))
      || (await probe('https://ipapi.co/json/', j => (j && j.city) || null))
      || null;
  });
}

async function runTask(row, proxy, config, ads) {
  const email = row['Email'];
  const profile = tasks.profileFromRow(row);
  const browserCfg = config.browser || {};
  const taskLog = msg => log.info(`[${email}] ${msg}`);

  let userId = null;
  let browser = null;

  try {
    userId = await ads.createProfile({
      name: `oasis-${email.split('@')[0]}-${Date.now().toString(36)}`,
      proxy,
      proxyType: config.proxy_type,
    });
    taskLog(`AdsPower profile ${userId}${proxy ? ` via ${proxy.host}:${proxy.port}` : ' on the local connection'}`);

    const wsEndpoint = await ads.start(userId);
    browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    const state = {};

    if (browserCfg.show_cursor) await human.installCursor(page);

    // Slightly different window geometry per run, so the viewport size isn't a
    // constant across thousands of signups.
    try {
      const cdp = await page.target().createCDPSession();
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { width: human.randInt(1180, 1600), height: human.randInt(820, 1020) },
      });
      await cdp.detach().catch(() => {});
    } catch { /* window sizing is a nicety, never fatal */ }

    // The page's own /confirm call is the authoritative success signal.
    let confirmed = false;
    let confirmError = '';
    page.on('response', async res => {
      if (!/fan2\/verify\/confirm/.test(res.url())) return;
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      if (res.status() === 200 && /"status"\s*:\s*"OK"/.test(body)) confirmed = true;
      else if (body) confirmError = `HTTP ${res.status()} ${body.slice(0, 200)}`;
    });

    const since = new Date(Date.now() - 60 * 1000);
    await page$.requestVerification(page, state, { url: config.return_url, email });
    log.success(`[${email}] Verification email requested`);

    const city = profile.city || await detectCity(page);
    if (!city) throw new Error('could not determine a city for the location field (add a "City" column to input.csv)');
    taskLog(`location city: ${city}`);

    taskLog('waiting for verification link…');
    const token = await mailbox.waitForToken(config.imap, {
      email,
      since,
      overrides: tasks.imapOverrides(row),
      timeout: config.imap?.wait_timeout_ms,
      onWarn: msg => log.warn(`[${email}] ${msg}`),
      onInfo: msg => taskLog(msg),
    });
    log.success(`[${email}] Verification link received`);

    await human.think(1500, 4000); // as if the user just opened the mail
    await page.goto(`${config.return_url}?token=${token}`, { waitUntil: 'networkidle2', timeout: 120000 });
    await human.skim(page, state);

    const venues = rankedVenues(config);
    taskLog(`cities (ranked): ${venues.join(' > ')}`);

    await page$.completeRegistration(page, state, {
      profile,
      city,
      venues,
      quizAnswer: browserCfg.quiz_answer || DEFAULT_QUIZ_ANSWER,
      log: taskLog,
      isDone: () => confirmed,
    });

    if (!confirmed) {
      await page.waitForFunction(
        () => /danke für deine registrierung|thanks for registering|thank you for registering/i.test(document.body.innerText),
        { timeout: 30000 },
      ).catch(() => {});
      const success = await page.evaluate(() =>
        /danke für deine registrierung|thanks for registering|thank you for registering/i.test(document.body.innerText));
      if (!success) throw new Error(confirmError || 'no confirmation from /confirm and no success page');
    }

    log.success(`[${email}] Registered for ${config.channel_name}`);
  } finally {
    if (browser) await browser.disconnect().catch(() => {});
    if (userId) {
      await ads.stop(userId);
      if (!(config.browser || {}).keep_profile) await ads.deleteProfile(userId);
    }
  }
}

function isProxyFault(err) {
  return err.kind !== 'mail' && /net::|ERR_|proxy|timeout|tunnel/i.test(err.message || '');
}

async function runTaskWithRetries(row, pool, config, ads, state) {
  const email = row['Email'];
  const attempts = Math.max(1, config.retries_per_task ?? 1);
  let lastDetail = '';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (state.abort) return;
    const item = pool.size > 0 ? pool.next() : null;
    const proxy = item ? item.proxy : null;

    try {
      await runTask(row, proxy, config, ads);
      pool.reportSuccess(item);
      tasks.recordResult(email, 'success');
      return;
    } catch (err) {
      lastDetail = err.message;
      log.error(`[${email}] Attempt ${attempt}/${attempts} failed: ${lastDetail}`);
      if (isProxyFault(err)) pool.reportFailure(item);
      if (/AdsPower .* unreachable/.test(lastDetail)) {
        state.abort = true;
        state.reason = lastDetail;
        tasks.recordResult(email, 'failed', lastDetail);
        return;
      }
      if (attempt < attempts) {
        const base = config.retry_delay_ms ?? 5000;
        await human.sleep(human.jitter(base, Math.min(base * 2 ** attempt, 60000)));
      }
    }
  }
  tasks.recordResult(email, 'failed', lastDetail);
}

async function runQueue(fns, maxConcurrent, delayMs, state) {
  const active = new Set();
  for (let i = 0; i < fns.length; i++) {
    if (state.abort) break;
    if (i > 0) await human.sleep(human.jitter(delayMs * 0.6, delayMs * 1.6));
    while (active.size >= maxConcurrent) await Promise.race(active);
    if (state.abort) break;
    const p = fns[i]().finally(() => active.delete(p));
    active.add(p);
  }
  await Promise.all(active);
}

async function main() {
  const config = tasks.loadConfig();
  const browserCfg = config.browser || {};

  if (!config.return_url) throw new Error('return_url missing in config.json');

  const ads = new AdsPower({
    base: browserCfg.adspower_api,
    groupId: browserCfg.group_id,
    headless: browserCfg.headless === true,
  });

  try {
    await ads.status();
  } catch (err) {
    throw new Error(`${err.message}\nStart the AdsPower client (its local API must be enabled) and try again.`);
  }

  const proxies = tasks.loadProxies();
  const allRows = tasks.loadTasks(msg => log.warn(msg));
  if (allRows.length === 0) {
    log.warn('No valid tasks found in input.csv');
    return;
  }

  const completed = tasks.loadCompleted(msg => log.warn(msg));
  const force = process.argv.includes('--force');
  const rows = force ? allRows : allRows.filter(r => !completed.has(r['Email'].toLowerCase()));
  const skipped = allRows.length - rows.length;
  if (force && completed.size > 0) log.warn('--force: re-running addresses that were already marked successful');
  if (rows.length === 0) {
    log.info(`All ${allRows.length} tasks already completed (see results.csv)`);
    return;
  }

  const maxConcurrent = browserCfg.max_concurrent ?? 2;
  const delayBetween = config.delay_between_tasks_ms ?? 3000;

  log.info(`Log file: ${log.file}`);
  log.info(`Mode: AdsPower browser | Tasks: ${rows.length}${skipped ? ` (skipped ${skipped} done)` : ''} | Proxies: ${proxies.length} | Concurrent: ${maxConcurrent}`);
  if (proxies.length === 0) log.warn('No proxies loaded – every profile uses the local connection');

  const pool = new ProxyPool(proxies, {
    failureThreshold: config.proxy_failure_threshold ?? 3,
    cooldownMs: config.proxy_cooldown_ms ?? 5 * 60 * 1000,
  });

  const state = { abort: false, reason: '' };
  const fns = rows.map(row => () => runTaskWithRetries(row, pool, config, ads, state));

  try {
    await runQueue(fns, maxConcurrent, delayBetween, state);
  } finally {
    await mailbox.closeAll();
  }

  if (state.abort) log.error(`Run aborted: ${state.reason}`);
  else log.info('All tasks finished');
}

main().catch(err => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
