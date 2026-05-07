// ─── Supabase client config helper ────────────────────────────────────────
// Server-side only. Never expose SUPABASE_SERVICE_KEY to the browser.

import { createClient } from "@supabase/supabase-js"
import ws from "ws"

let _client = null

// supabase-js v2 retries failed fetches up to 4 times internally.
// A per-fetch AbortController multiplies: 4 retries × timeout = too long.
// Instead we wrap the entire Supabase promise with a hard outer deadline.
function withDeadline(promise, ms = 6_000) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Supabase deadline exceeded (${ms}ms)`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

function getClient() {
  if (!_client) {
    // Pass ws as Realtime transport — required on Node 20 (no native WebSocket).
    // Without this, supabase-js v2.103+ throws on createClient() and breaks
    // all token lookups.
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      {
        auth: { persistSession: false },
        realtime: { transport: ws },
      }
    )
  }
  return _client
}

// ─── In-memory cache (5 min TTL) ──────────────────────────────────────────
const _cache = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 min TTL

function cacheGet(key) {
  const entry = _cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null }
  return entry.data
}

function cacheSet(key, data) {
  _cache.set(key, { data, ts: Date.now() })
}

// ─── Fetch client config by slug ──────────────────────────────────────────
/**
 * @param {string} slug
 * @returns {Promise<object|null>} client row or null
 */
export async function getClientConfig(slug) {
  const cached = cacheGet(`client:${slug}`)
  if (cached) return cached

  try {
    const { data, error } = await withDeadline(
      getClient()
        .from("clients")
        .select("*")
        .eq("slug", slug)
        .eq("status", "active")
        .single()
    )
    if (error || !data) return null
    cacheSet(`client:${slug}`, data)
    return data
  } catch (e) {
    console.error('[supabase] getClientConfig failed:', e.message)
    return null
  }
}

/**
 * Validate access token against a client row.
 * Used by Notion-button-triggered API routes.
 * @param {string} token
 * @returns {Promise<object|null>} client row or null
 */
export async function getClientByToken(token) {
  if (!token) return null
  const cached = cacheGet(`token:${token}`)
  if (cached) return cached

  try {
    const { data, error } = await withDeadline(
      getClient()
        .from("clients")
        .select("*")
        .eq("access_token", token)
        .eq("status", "active")
        .single()
    )
    if (error) {
      console.error('[supabase] getClientByToken error:', JSON.stringify({ code: error.code, message: error.message, hint: error.hint }))
      return null
    }
    if (!data) {
      console.warn('[supabase] getClientByToken: token not found or not active:', token.slice(0, 8) + '...')
      return null
    }
    cacheSet(`token:${token}`, data)
    return data
  } catch (e) {
    console.error('[supabase] getClientByToken deadline/exception:', e.message)
    return null
  }
}

/**
 * Origin allowlist check.
 * If client.labels.allowedOrigins is set, validates the request Origin header.
 * Returns true if allowed, false if blocked.
 * No restriction when allowedOrigins is not configured.
 */
export function checkOrigin(client, req) {
  const allowed = client?.labels?.allowedOrigins
  if (!allowed || !Array.isArray(allowed) || allowed.length === 0) return true
  const origin = req.headers.origin || req.headers.referer || ""
  return allowed.some(o => origin.startsWith(o))
}

/**
 * Invalidate cache entries for a slug (call after config updates).
 * Also clears any token-based cache entries for the same client.
 */
export function invalidateClientCache(slug) {
  // Clear slug-based keys
  for (const key of _cache.keys()) {
    if (key.includes(slug)) _cache.delete(key)
  }
  // Clear token-based keys where the cached client matches this slug
  for (const [key, entry] of _cache.entries()) {
    if (key.startsWith("token:") && entry.data?.slug === slug) {
      _cache.delete(key)
    }
  }
}

/**
 * Helper: get the Notion API token for a client.
 * Uses the client's own notion_token if set, otherwise falls back to
 * the shared NOTION_API_KEY env var (Opxio's internal token).
 */
export function getNotionToken(client) {
  return client?.notion_token || process.env.NOTION_API_KEY
}

/**
 * Helper: resolve a Notion DB id for a client.
 * Falls back to the internal Opxio DB ids if not overridden.
 */
export function resolveDB(client, dbKey, fallback) {
  return client?.databases?.[dbKey] || fallback
}

/**
 * Helper: resolve a field name via client's field_map
 */
export function resolveField(client, stdField, fallback) {
  return client?.field_map?.[stdField] || fallback
}

/**
 * Helper: resolve a label via client's labels
 */
export function resolveLabel(client, key, fallback) {
  return client?.labels?.[key] || fallback
}

/**
 * Widget access control.
 * If client.allowed_widgets is null/undefined → all widgets are allowed (no restriction).
 * If it is a non-empty array → only listed slugs are allowed.
 * Slug format matches the URL path segment: "marketing/stats", "marketing/campaigns", etc.
 *
 * @param {object} client  - client row from Supabase
 * @param {string} widget  - slug to check, e.g. "marketing/stats"
 * @returns {boolean}
 */
export function hasWidgetAccess(client, widget) {
  // Stored in client.labels.allowed_widgets (no schema change needed — reuses existing labels JSONB)
  // null / missing = no restriction (all widgets allowed)
  // array present = whitelist — only listed slugs are accessible
  const list = client?.labels?.allowed_widgets
  if (!list || !Array.isArray(list) || list.length === 0) return true
  return list.includes(widget)
}
