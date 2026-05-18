// handlers/clients/opxio/entity-contacts.js
// Opxio internal — Entity & Contacts strip widget

import { getClientByToken, getNotionToken } from "../../../lib/supabase.js"
import { cacheGet, cacheSet, cacheKey, cacheDelete } from "../../../lib/cache.js"

const ENTITY_DB   = 'fcdfe60097f682c09be901fe6ebb6b41'
const CONTACTS_DB = 'b0afe60097f68265b93401fbc6f0fec4'

async function queryAll(dbId, notionKey) {
  const headers = {
    'Authorization': `Bearer ${notionKey}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  }
  let results = [], hasMore = true, cursor
  while (hasMore) {
    const body = { page_size: 100 }
    if (cursor) body.start_cursor = cursor
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST', headers, body: JSON.stringify(body)
    })
    if (!r.ok) throw new Error(await r.text())
    const d = await r.json()
    results = results.concat(d.results)
    hasMore = d.has_more
    cursor  = d.next_cursor
  }
  return results
}

const getSelect = p => p?.select?.name || null
const getRelIds = p => (p?.relation || []).map(r => r.id)

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })
  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })

  const NOTION_KEY = getNotionToken(client)
  const ck = cacheKey('opxio:entity-contacts', client.id)
  if (req.query.refresh === '1') cacheDelete(ck)
  let cached = cacheGet(ck)

  if (!cached) {
    const [entities, contacts] = await Promise.all([
      queryAll(ENTITY_DB, NOTION_KEY),
      queryAll(CONTACTS_DB, NOTION_KEY),
    ])
    cacheSet(ck, { entities, contacts })
    cached = { data: { entities, contacts }, stale: false }
  } else if (cached.stale) {
    Promise.all([
      queryAll(ENTITY_DB, NOTION_KEY),
      queryAll(CONTACTS_DB, NOTION_KEY),
    ]).then(([entities, contacts]) => cacheSet(ck, { entities, contacts })).catch(console.error)
  }

  const { entities, contacts } = cached.data
  const now   = new Date()
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1)

  // Entity stats
  let totalEntities = 0, activeClients = 0, prospects = 0
  let newThisMonth  = 0, noContact = 0

  for (const page of entities) {
    const p      = page.properties
    const status = getSelect(p['Status'])
    const people = getRelIds(p['People'])
    const created = new Date(page.created_time)

    totalEntities++
    if (status === 'Active Client') activeClients++
    if (status === 'Prospect')      prospects++
    if (created >= mStart)          newThisMonth++
    if (people.length === 0)        noContact++
  }

  return res.status(200).json({
    entities: {
      total:        totalEntities,
      newThisMonth,
      activeClients,
      prospects,
      noContact,
    },
    contacts: {
      total: contacts.length,
    },
    updatedAt: now.toISOString(),
  })
}
