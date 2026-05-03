// ─── lib/queue.js — shared Notion request queue ───────────────────────────
// Notion rate limit: ~3 req/sec. This queue caps concurrent Notion calls
// across all handlers so we never hammer their API simultaneously.
// p-queue v8 is ESM-only.

import PQueue from 'p-queue'

export const notionQueue = new PQueue({ concurrency: 3 })
