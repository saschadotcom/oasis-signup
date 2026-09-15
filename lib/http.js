const { Session, initTLS, destroyTLS } = require('node-tls-client');

// Some of these endpoints sit behind Cloudflare, which blocks Node's native TLS
// handshake outright (403 "Sorry, you have been blocked"), so every request goes
// through a Chrome-impersonating TLS stack instead of axios.
//
// TLS handshake, user agent and client hints have to describe the same browser
// build – a mismatch between them is a stronger bot signal than no rotation at
// all. Each entry below is therefore a complete, self-consistent bundle.
//
// The profile is passed as a plain string rather than via ClientIdentifier:
// the package's enum stops at chrome_131, while the native library it loads
// ships profiles well beyond that. Claiming a ~1.5 year old Chrome would make
// us a rarity in the traffic mix, and an unknown name degrades to a current
// Chrome profile instead of failing, so the string form is safe.
const CHROME_BUILDS = [
  {
    version: 146,
    client: 'chrome_146',
    brands: '"Google Chrome";v="146", "Chromium";v="146", "Not)A;Brand";v="24"',
  },
  {
    // Same handshake as a resumed connection (pre-shared key). Real traffic
    // contains both variants.
    version: 150,
    client: 'chrome_150_PSK',
    brands: '"Google Chrome";v="150", "Chromium";v="150", "Not)A;Brand";v="24"',
  },
  {
    version: 152,
    client: 'chrome_152',
    brands: '"Google Chrome";v="152", "Chromium";v="152", "Not)A;Brand";v="24"',
  },
];

const PLATFORMS = [
  { hint: '"Windows"', ua: 'Windows NT 10.0; Win64; x64' },
  { hint: '"macOS"', ua: 'Macintosh; Intel Mac OS X 10_15_7' },
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomProfile() {
  const build = pick(CHROME_BUILDS);
  const platform = pick(PLATFORMS);

  return {
    name: `${build.client}/${platform.hint.replace(/"/g, '')}`,
    client: build.client,
    brands: build.brands,
    platform: platform.hint,
    userAgent: `Mozilla/5.0 (${platform.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${build.version}.0.0.0 Safari/537.36`,
  };
}

function normalizeType(type) {
  const t = (type || 'http').toLowerCase();
  if (t === 'socks' || t === 'socks5') return 'socks5';
  if (t === 'socks4') return 'socks4';
  if (t === 'https') return 'https';
  return 'http';
}

function proxyToUrl(proxy, type) {
  const auth = proxy.user
    ? `${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.pass)}@`
    : '';
  return `${normalizeType(type)}://${auth}${proxy.host}:${proxy.port}`;
}

// CapSolver expects "scheme:host:port:user:pass".
function proxyToCapsolver(proxy, type) {
  const auth = proxy.user ? `:${proxy.user}:${proxy.pass}` : '';
  return `${normalizeType(type)}:${proxy.host}:${proxy.port}${auth}`;
}

function baseHeaders(profile) {
  return {
    'user-agent': profile.userAgent,
    'accept-language': 'en-US,en;q=0.9',
    // Chrome advertises zstd since v123, so every build we impersonate has to.
    // The native library links klauspost/compress/zstd, so a zstd response decodes.
    'accept-encoding': 'gzip, deflate, br, zstd',
    'sec-ch-ua': profile.brands,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': profile.platform,
  };
}

// Without an explicit order the Go layer emits the header map in arbitrary
// order, which on its own separates us from any real browser. A HAR cannot
// settle the question — DevTools sorts request headers alphabetically before
// exporting them — so this follows Chrome's documented wire order for
// fetch/XHR requests. Names not present on a request are skipped.
const CHROME_HEADER_ORDER = [
  'content-length',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'user-agent',
  'content-type',
  'accept',
  'origin',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'referer',
  'accept-encoding',
  'accept-language',
  'priority',
];

class HttpSession {
  constructor({ proxy, proxyType, profile, timeout = 45000 }) {
    this.profile = profile || randomProfile();
    this.capsolverProxy = proxy ? proxyToCapsolver(proxy, proxyType) : null;
    this.session = new Session({
      clientIdentifier: this.profile.client,
      // Chrome shuffles its TLS extensions per connection; keeping a fixed
      // order would make every task look like the exact same client.
      randomTlsExtensionOrder: true,
      headerOrder: CHROME_HEADER_ORDER,
      timeout,
      ...(proxy && { proxy: proxyToUrl(proxy, proxyType) }),
    });
  }

  async #send(method, url, { headers = {}, body } = {}) {
    const res = await this.session[method](url, {
      headers: { ...baseHeaders(this.profile), ...headers },
      followRedirects: true,
      ...(body !== undefined && { body }),
    });

    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`${method.toUpperCase()} ${url} -> HTTP ${res.status}`);
      err.status = res.status;
      err.body = text.slice(0, 500);
      throw err;
    }
    return { status: res.status, text };
  }

  async getJson(url, headers) {
    const { text } = await this.#send('get', url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        priority: 'u=1, i',
        ...headers,
      },
    });

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Expected JSON from ${url} but got: ${text.slice(0, 200)}`);
    }
  }

  async postJson(url, payload, headers) {
    const { text } = await this.#send('post', url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        priority: 'u=1, i',
        ...headers,
      },
      body: JSON.stringify(payload),
    });

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Expected JSON from ${url} but got: ${text.slice(0, 200)}`);
    }
  }

  close() {
    return this.session.close().catch(() => {});
  }
}

function createSession(options) {
  return new HttpSession(options);
}

module.exports = { createSession, randomProfile, initTLS, destroyTLS };
