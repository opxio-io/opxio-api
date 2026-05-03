// ─── cache.js — In-memory Notion data cache ───────────────────────────────
// TTL: 5 minutes. Stale-while-revalidate: serve stale instantly, refresh in bg.
// Railway is always-on so the cache persists between requests.

const _store = new Map()
const TTL_MS   = 5 * 60 * 1000  // 5 minutes — fresh window
const STALE_MS = 30 * 60 * 1000 // 30 minutes — max stale age before hard miss

export function cacheKey(...parts) {
  return parts.join(":")
}

// Returns { data, stale } — stale=true means bg refresh was triggered
export function cacheGet(key) {
  const entry = _store.get(key)
  if (!entry) return null
  const age = Date.now() - entry.ts
  if (age > STALE_MS) { _store.delete(key); return null } // too old, hard miss
  return { data: entry.data, stale: age > TTL_MS }
}

export function cacheSet(key, data) {
  _store.set(key, { data, ts: Date.now() })
}

export function cacheDelete(key) {
  _store.delete(key)
}

export function cacheClear() {
  _store.clear()
}
