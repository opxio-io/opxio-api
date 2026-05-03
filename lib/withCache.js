// ─── lib/withCache.js — Cache wrapper for data handlers ──────────────────
// Wraps an async fetcher with stale-while-revalidate caching.
//
// Usage:
//   const { data, cacheStatus } = await withCache('my:key', () => fetchFromNotion())
//
// Returns: { data, cacheStatus: 'HIT' | 'STALE' | 'MISS' }
// - HIT:   Fresh data from cache, returned instantly
// - STALE: Stale data returned instantly, background refresh queued
// - MISS:  No cache, awaits fetch (concurrent requests share one promise)

import { cacheGet, cacheSet } from './cache.js'

const _inflight = new Map()

export async function withCache(key, fetcher) {
  const cached = cacheGet(key)

  // Fresh HIT — return immediately
  if (cached && !cached.stale) {
    return { data: cached.data, cacheStatus: 'HIT' }
  }

  // Stale — return instantly, refresh in background
  if (cached && cached.stale) {
    if (!_inflight.has(key)) {
      const p = fetcher()
        .then(d => { cacheSet(key, d); return d })
        .finally(() => _inflight.delete(key))
      _inflight.set(key, p)
    }
    return { data: cached.data, cacheStatus: 'STALE' }
  }

  // MISS — wait for fetch (deduplicate concurrent cold-cache requests)
  if (_inflight.has(key)) {
    return { data: await _inflight.get(key), cacheStatus: 'MISS' }
  }
  const p = fetcher()
    .then(d => { cacheSet(key, d); return d })
    .finally(() => _inflight.delete(key))
  _inflight.set(key, p)
  return { data: await p, cacheStatus: 'MISS' }
}
