// ─── lib/notionHelpers.js — Shared Notion paginator ──────────────────────
// Queued (max 3 concurrent via p-queue) + per-page 8s AbortController timeout.
// Import queryAll() into any handler instead of copy-pasting.

import { notionQueue } from './queue.js'

const TIMEOUT_MS = 8_000

export function makeNotionHeaders(notionKey) {
  return {
    Authorization:    `Bearer ${notionKey}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  }
}

export async function queryAll(dbId, notionKey, filter = null) {
  const headers = makeNotionHeaders(notionKey)
  let results = [], hasMore = true, cursor
  while (hasMore) {
    const ctrl  = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const body = { page_size: 100 }
      if (cursor) body.start_cursor = cursor
      if (filter)  body.filter      = filter
      const d = await notionQueue.add(async () => {
        const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
          method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
        })
        if (!r.ok) throw new Error(`Notion ${r.status}: ${await r.text()}`)
        return r.json()
      })
      results = results.concat(d.results)
      hasMore  = d.has_more
      cursor   = d.next_cursor
    } finally {
      clearTimeout(timer)
    }
  }
  return results
}
