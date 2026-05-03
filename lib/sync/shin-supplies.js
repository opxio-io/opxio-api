// ─── lib/sync/shin-supplies.js — Notion → Postgres sync ─────────────────
// Pulls all leads + people from Notion, upserts as JSONB.
// Raw Notion page objects are stored verbatim so crm-pipeline.js can use
// them without any changes to computeStats().

import { pool } from '../db.js'
import { getClientConfig, getNotionToken, resolveDB } from '../supabase.js'

const ENQUIRY_DB_DEFAULT = '71c9ba4af0694291876bf78422805f18'
const PEOPLE_DB_DEFAULT  = '34cfe60097f680e1bac0e75b431bc325'

// ── Notion paginator ──────────────────────────────────────────────────────
async function queryAll(dbId, notionKey) {
  const headers = {
    Authorization:    `Bearer ${notionKey}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  }
  let results = [], hasMore = true, cursor
  while (hasMore) {
    const body = { page_size: 100 }
    if (cursor) body.start_cursor = cursor
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST', headers, body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`Notion query failed: ${await r.text()}`)
    const d = await r.json()
    results = results.concat(d.results)
    hasMore  = d.has_more
    cursor   = d.next_cursor
  }
  return results
}

// ── Schema bootstrap ──────────────────────────────────────────────────────
export async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shin_supplies_leads (
      notion_id  TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      synced_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS shin_supplies_people (
      notion_id  TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      synced_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sync_log (
      id           SERIAL PRIMARY KEY,
      client       TEXT NOT NULL,
      synced_at    TIMESTAMPTZ DEFAULT NOW(),
      leads_count  INT,
      people_count INT,
      duration_ms  INT
    );
  `)
}

// ── Main sync function ────────────────────────────────────────────────────
/**
 * Pulls all Shin Supplies data from Notion and upserts into Postgres.
 * Safe to call repeatedly — upsert never loses existing rows.
 * @returns {{ leadsCount, peopleCount, durationMs }}
 */
export async function syncShinSupplies() {
  const t0 = Date.now()

  // Resolve Notion credentials via Supabase client config
  const client     = await getClientConfig('shin-supplies')
  const notionKey  = getNotionToken(client) || process.env.NOTION_API_KEY
  const enquiryDb  = resolveDB(client, 'enquiry_submissions', ENQUIRY_DB_DEFAULT)
  const peopleDb   = resolveDB(client, 'people', PEOPLE_DB_DEFAULT)

  if (!notionKey) throw new Error('No Notion API key available for shin-supplies sync')

  // Ensure tables exist
  await createTables()

  // Fetch from Notion in parallel
  const [leads, people] = await Promise.all([
    queryAll(enquiryDb, notionKey),
    queryAll(peopleDb,  notionKey).catch(() => []),
  ])

  // Upsert leads
  if (leads.length > 0) {
    // Build bulk upsert values
    const leadsValues = leads.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')
    const leadsParams = leads.flatMap(p => [p.id, JSON.stringify(p)])
    await pool.query(
      `INSERT INTO shin_supplies_leads (notion_id, data)
       VALUES ${leadsValues}
       ON CONFLICT (notion_id)
       DO UPDATE SET data = EXCLUDED.data, synced_at = NOW()`,
      leadsParams
    )
  }

  // Upsert people
  if (people.length > 0) {
    const peopleValues = people.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')
    const peopleParams = people.flatMap(p => [p.id, JSON.stringify(p)])
    await pool.query(
      `INSERT INTO shin_supplies_people (notion_id, data)
       VALUES ${peopleValues}
       ON CONFLICT (notion_id)
       DO UPDATE SET data = EXCLUDED.data, synced_at = NOW()`,
      peopleParams
    )
  }

  const durationMs = Date.now() - t0

  // Log the sync
  await pool.query(
    `INSERT INTO sync_log (client, leads_count, people_count, duration_ms)
     VALUES ($1, $2, $3, $4)`,
    ['shin-supplies', leads.length, people.length, durationMs]
  ).catch(() => {}) // non-fatal

  console.log(`[sync] shin-supplies: ${leads.length} leads, ${people.length} people — ${durationMs}ms`)
  return { leadsCount: leads.length, peopleCount: people.length, durationMs }
}

// ── Read from Postgres ────────────────────────────────────────────────────
/**
 * Reads cached Notion data from Postgres.
 * Returns { pages, repMap, total } — same shape as the in-memory cache.
 * Returns null if tables are empty (sync hasn't run yet).
 */
export async function readFromDb() {
  await createTables()

  const [leadsRes, peopleRes] = await Promise.all([
    pool.query('SELECT data FROM shin_supplies_leads'),
    pool.query('SELECT data FROM shin_supplies_people'),
  ])

  if (leadsRes.rows.length === 0) return null  // empty — sync hasn't run

  const pages  = leadsRes.rows.map(r => r.data)
  const people = peopleRes.rows.map(r => r.data)

  const repMap = {}
  for (const p of people) {
    const nameProp = p.properties?.['Name'] || p.properties?.['Nama'] || p.properties?.['Full Name']
    const name = (nameProp?.title || []).map(t => t.plain_text).join('')
    if (name) { repMap[p.id] = name; repMap[p.id.replace(/-/g, '')] = name }
  }

  return { pages, repMap, total: pages.length }
}
