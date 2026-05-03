// ─── lib/db.js — PostgreSQL connection pool ──────────────────────────────
// Reads DATABASE_URL from env (Railway injects this automatically when you
// add a Postgres plugin to your project).
// Gracefully no-ops if DATABASE_URL is not set — existing routes are unaffected.

import pg from 'pg'
const { Pool } = pg

let _pool = null

function getPool() {
  if (_pool) return _pool
  if (!process.env.DATABASE_URL) {
    console.warn('[db] DATABASE_URL not set — Postgres disabled')
    return null
  }
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // required for Railway Postgres
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
  _pool.on('error', (err) => console.error('[db] pool error:', err.message))
  return _pool
}

export const pool = new Proxy({}, {
  get(_, prop) {
    const p = getPool()
    if (!p) throw new Error('Postgres not configured — add DATABASE_URL env var')
    return p[prop].bind(p)
  }
})

/** Returns true if Postgres is configured */
export function isPostgresEnabled() {
  return !!process.env.DATABASE_URL
}

/** Quick health check */
export async function pingDb() {
  const p = getPool()
  if (!p) return false
  try {
    await p.query('SELECT 1')
    return true
  } catch {
    return false
  }
}
