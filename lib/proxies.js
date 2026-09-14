// Tracks per-proxy health so IPs that keep getting blocked (403/429/5xx) are
// parked for a cooldown instead of being handed out again and again – which at
// scale just wastes CapSolver spend and time on dead IPs.
class ProxyPool {
  constructor(proxies, { failureThreshold = 3, cooldownMs = 5 * 60 * 1000 } = {}) {
    this.items = proxies.map(proxy => ({ proxy, failures: 0, cooldownUntil: 0 }));
    this.cursor = 0;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
  }

  get size() {
    return this.items.length;
  }

  get available() {
    const now = Date.now();
    return this.items.filter(i => i.cooldownUntil <= now).length;
  }

  // Round-robin, skipping proxies in cooldown. If everything is cooling down,
  // return the one that frees up soonest rather than stalling the run.
  next() {
    if (this.items.length === 0) return null;
    const now = Date.now();
    let soonest = null;

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[(this.cursor + i) % this.items.length];
      if (item.cooldownUntil <= now) {
        this.cursor = (this.cursor + i + 1) % this.items.length;
        return item;
      }
      if (!soonest || item.cooldownUntil < soonest.cooldownUntil) soonest = item;
    }
    return soonest;
  }

  reportSuccess(item) {
    if (!item) return;
    item.failures = 0;
    item.cooldownUntil = 0;
  }

  reportFailure(item) {
    if (!item) return;
    item.failures += 1;
    if (item.failures >= this.failureThreshold) {
      item.cooldownUntil = Date.now() + this.cooldownMs;
      item.failures = 0;
    }
  }
}

module.exports = { ProxyPool };
