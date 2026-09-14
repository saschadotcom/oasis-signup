const axios = require('axios');

const API = 'https://api.capsolver.com';

let cfg = {};

function init(config) {
  cfg = config;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function post(path, body) {
  let res;
  try {
    res = await axios.post(`${API}${path}`, body, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    // A raw HTTP 4xx (usually 400) means the API rejected the request itself –
    // almost always an invalid/placeholder capsolver_api_key. Surface that
    // instead of axios's opaque "Request failed with status code 400".
    const data = err.response?.data;
    const detail = data
      ? (data.errorCode || data.errorDescription || JSON.stringify(data))
      : err.message;
    throw new Error(`CapSolver ${path} failed (HTTP ${err.response?.status ?? '?'}): ${detail} – check capsolver_api_key`);
  }
  if (res.data.errorId) {
    throw new Error(`CapSolver: ${res.data.errorCode || ''} ${res.data.errorDescription || 'unknown error'}`.trim());
  }
  return res.data;
}

async function getBalance() {
  const data = await post('/getBalance', { clientKey: cfg.capsolver_api_key });
  return data.balance;
}

/**
 * Solves the reCAPTCHA guarding the /confirm call. Oasis uses an invisible,
 * score-based reCAPTCHA Enterprise widget, so `action` should match the value
 * the page passes to grecaptcha.enterprise.execute for a usable score.
 * Returns the gRecaptchaResponse token that /confirm expects in `captcha`.
 */
async function solveRecaptcha({ websiteURL, websiteKey, action, enterprise = true, proxy }) {
  const useProxy = cfg.capsolver_use_proxy && proxy;

  let type;
  if (enterprise) type = useProxy ? 'ReCaptchaV3EnterpriseTask' : 'ReCaptchaV3EnterpriseTaskProxyLess';
  else type = useProxy ? 'ReCaptchaV3Task' : 'ReCaptchaV3TaskProxyLess';

  const task = {
    type,
    websiteURL,
    websiteKey,
    ...(action && { pageAction: action }),
    ...(useProxy && { proxy }),
  };

  const created = await post('/createTask', {
    clientKey: cfg.capsolver_api_key,
    task,
  });

  if (created.status === 'ready' && created.solution) {
    return created.solution.gRecaptchaResponse;
  }

  const deadline = Date.now() + (cfg.capsolver_timeout_ms ?? 180000);
  await sleep(2000);

  while (Date.now() < deadline) {
    const result = await post('/getTaskResult', {
      clientKey: cfg.capsolver_api_key,
      taskId: created.taskId,
    });

    if (result.status === 'ready') return result.solution.gRecaptchaResponse;
    if (result.status === 'failed') {
      throw new Error(`CapSolver: task failed ${result.errorDescription || ''}`.trim());
    }

    await sleep(3000);
  }

  throw new Error('CapSolver: timeout while waiting for reCAPTCHA token');
}

module.exports = { init, getBalance, solveRecaptcha };
