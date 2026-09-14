const { Session, ClientIdentifier, initTLS, destroyTLS } = require('node-tls-client');

// Some of these endpoints sit behind Cloudflare, which blocks Node's native TLS
// handshake outright (403 "Sorry, you have been blocked"), so every request goes
// through a Chrome-impersonating TLS stack instead of axios.
//
// TLS handshake, user agent and client hints have to describe the same browser
// build – a mismatch between them is a stronger bot signal than no rotation at
// all. Each entry below is therefore a complete, self-consistent bundle.
const CHROME_BUILDS = [
  {
    version: 124,
    client: ClientIdentifier.chrome_124,
    brands: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  },
  {
    version: 131,
    client: ClientIdentifier.chrome_131,
    brands: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  },
  {
    // Same browser build, but the handshake carries a pre-shared key like a
    // resumed connection does. Real traffic contains both variants.
    version: 131,
    client: ClientIdentifier.chrome_131_psk,
    brands: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
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
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': profile.brands,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': profile.platform,
  };
}

class HttpSession {
  constructor({ proxy, proxyType, profile, timeout = 45000 }) {
    this.profile = profile || randomProfile();
    this.capsolverProxy = proxy ? proxyToCapsolver(proxy, proxyType) : null;
    this.session = new Session({
      clientIdentifier: this.profile.client,
      // Chrome shuffles its TLS extensions per connection; keeping a fixed
      // order would make every task look like the exact same client.
      randomTlsExtensionOrder: true,
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
