const axios = require('axios');

const DEFAULT_BASE = 'http://127.0.0.1:50325';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// AdsPower's local API rejects bursts (roughly one request per second), so all
// calls are funnelled through a single queue with a minimum gap between them.
class AdsPower {
  constructor({ base = DEFAULT_BASE, groupId = '', gapMs = 1300, headless = false } = {}) {
    this.base = base.replace(/\/$/, '');
    this.groupId = groupId;
    this.gapMs = gapMs;
    this.headless = headless;
    this.queue = Promise.resolve();
    this.lastCall = 0;
  }

  request(path, { params, body, method = 'get' } = {}) {
    const run = async () => {
      const wait = this.gapMs - (Date.now() - this.lastCall);
      if (wait > 0) await sleep(wait);
      this.lastCall = Date.now();

      const url = `${this.base}${path}`;
      let res;
      try {
        res = method === 'post'
          ? await axios.post(url, body, { timeout: 120000 })
          : await axios.get(url, { params, timeout: 120000 });
      } catch (err) {
        throw new Error(`AdsPower ${path} unreachable: ${err.message} – is the AdsPower client running?`);
      }
      if (res.data.code !== 0) throw new Error(`AdsPower ${path}: ${res.data.msg}`);
      return res.data.data;
    };

    // chain onto the queue so concurrent tasks cannot interleave requests
    const result = this.queue.then(run, run);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  async status() {
    return this.request('/status');
  }

  // Uses the configured group, else the first existing one, else creates it.
  async ensureGroup() {
    if (this.groupId) return this.groupId;

    const list = await this.request('/api/v1/group/list', { params: { page: 1, page_size: 50 } });
    if (list.list && list.list.length > 0) {
      this.groupId = list.list[0].group_id;
      return this.groupId;
    }
    const created = await this.request('/api/v1/group/create', { method: 'post', body: { group_name: 'oasis' } });
    this.groupId = created.group_id;
    return this.groupId;
  }

  // proxy === null means "use the machine's own connection" (proxies.txt sentinel).
  proxyConfig(proxy, proxyType = 'http') {
    if (!proxy) return { proxy_soft: 'no_proxy' };
    const type = ['http', 'https', 'socks5', 'socks4'].includes((proxyType || '').toLowerCase())
      ? proxyType.toLowerCase()
      : 'http';
    return {
      proxy_soft: 'other',
      proxy_type: type,
      proxy_host: proxy.host,
      proxy_port: String(proxy.port),
      ...(proxy.user && { proxy_user: proxy.user, proxy_password: proxy.pass }),
    };
  }

  async createProfile({ name, proxy, proxyType }) {
    const group_id = await this.ensureGroup();
    const data = await this.request('/api/v1/user/create', {
      method: 'post',
      body: {
        name,
        group_id,
        user_proxy_config: this.proxyConfig(proxy, proxyType),
        // Let AdsPower mint a fresh, self-consistent fingerprint per profile –
        // that is the whole reason for using it over a plain Chrome instance.
        fingerprint_config: {
          automatic_timezone: '1',
          language: ['en-US', 'en'],
          webrtc: 'proxy',
          random_ua: {
            ua_browser: ['chrome'],
            ua_system_version: ['Windows 10', 'Windows 11', 'Mac OS X 13', 'Mac OS X 14'],
          },
        },
      },
    });
    return data.id;
  }

  async start(userId) {
    const data = await this.request('/api/v1/browser/start', {
      params: { user_id: userId, open_tabs: 1, headless: this.headless ? 1 : 0 },
    });
    if (!data.ws || !data.ws.puppeteer) throw new Error('AdsPower returned no puppeteer websocket');
    return data.ws.puppeteer;
  }

  async stop(userId) {
    return this.request('/api/v1/browser/stop', { params: { user_id: userId } }).catch(() => null);
  }

  async deleteProfile(userId) {
    return this.request('/api/v1/user/delete', { method: 'post', body: { user_ids: [userId] } }).catch(() => null);
  }
}

module.exports = { AdsPower };
