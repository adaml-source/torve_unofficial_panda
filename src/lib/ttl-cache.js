// Minimal TTL cache with soft size cap. Evicts LRU when over capacity.
// Stores async-fn results so repeat calls for the same key return from
// memory instead of hitting rate-limited upstream APIs.

export class TtlCache {
  constructor({ maxEntries = 500 } = {}) {
    this.max = maxEntries;
    this.map = new Map();
  }

  _now() { return Date.now(); }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this._now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU order
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: this._now() + ttlMs });
    while (this.map.size > this.max) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }

  /**
   * Memoize an async function: if a cached value exists, return it;
   * otherwise run `fn`, cache the result, and return it.
   * `pickTtl(value)` lets callers shorten TTL for empty/error results so
   * the system recovers quickly when upstream comes back.
   */
  async memoize(key, fn, { ttlMs, pickTtl }) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    const ttl = pickTtl ? pickTtl(value) : ttlMs;
    this.set(key, value, ttl);
    return value;
  }
}
