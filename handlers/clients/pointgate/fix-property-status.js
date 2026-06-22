// POST /api/clients/pointgate/fix-property-status
// One-time: sets Status = Occupied for all properties where a tenant resolves
// Protected by x-notify-secret

import { queryDB, plain, hdrs, NOTION_VERSION } from '../../../lib/notion.js'
import { cacheKey, cacheDelete } from '../../../lib/cache.js'

const NOTION_KEY  = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY
const SECRET      = () => process.env.POINTGATE_NOTIFY_SECRET || 'pointgate-notify'

const PG = {
  PROPERTIES: '979e0918c8db459694657c30743c4846',
  TENANTS:    '11bc170f3fc643b2b0e12ef9ef712300',
  PAYMENTS:   'cdc0a5b7e9384afabdc83cb24004f6f8',
}

const getRelIds = p => (p?.relation || []).map(r => r.id.replace(/-/g, ''))

async function patchStatus(pageId, token) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: hdrs(token),
    body: JSON.stringify({
      properties: { Status: { status: { name: 'Occupied' } } }
    })
  })
  if (!r.ok) throw new Error(`patch ${pageId}: ${r.status} ${await r.text()}`)
}

export async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (req.headers['x-notify-secret'] !== SECRET())
    return res.status(401).json({ error: 'unauthorized' })

  const token = NOTION_KEY()

  // Fetch all three DBs
  const [propPages, tenantPages, payPages] = await Promise.all([
    queryDB(PG.PROPERTIES, undefined, token),
    queryDB(PG.TENANTS,    undefined, token),
    queryDB(PG.PAYMENTS,   undefined, token),
  ])

  // propId → lot name
  const propMap = {}
  for (const p of propPages) {
    propMap[p.id.replace(/-/g,'')] = plain(p.properties['Property Name']?.title||[]) || ''
  }

  // propId → [tenantName]  (from Tenant.Property dual)
  const propToTenants = {}
  for (const p of tenantPages) {
    const name = plain(p.properties['Full Name']?.title||[]) || ''
    for (const pid of getRelIds(p.properties['Property'])) {
      if (!propToTenants[pid]) propToTenants[pid] = []
      propToTenants[pid].push(name)
    }
  }

  // lot → tenantId  (fallback from payment records)
  const lotHasTenant = new Set()
  for (const page of payPages) {
    const pr     = page.properties
    const tenId  = getRelIds(pr['Tenant'])[0]
    if (!tenId) continue
    const propId = getRelIds(pr['Property'])[0] || ''
    const lot    = propMap[propId] || ''
    if (lot) lotHasTenant.add(lot)
  }

  // Determine which pages need updating
  const toFix = []
  for (const page of propPages) {
    const pid     = page.id.replace(/-/g,'')
    const lot     = propMap[pid] || ''
    const status  = page.properties['Status']?.status?.name || ''
    const needFix = status !== 'Occupied' && status !== 'Under Maintenance' &&
                    status !== 'Staff Housing'
    const hasTenant = (propToTenants[pid]?.length > 0) || lotHasTenant.has(lot)
    if (needFix && hasTenant) toFix.push(page.id)
  }

  // Batch update with small delay between calls
  const results = { updated: 0, failed: 0, errors: [] }
  for (const pageId of toFix) {
    try {
      await patchStatus(pageId, token)
      results.updated++
      await new Promise(r => setTimeout(r, 120))  // ~8 req/s — safe under Notion rate limit
    } catch (err) {
      results.failed++
      results.errors.push(err.message)
    }
  }

  // Bust properties cache
  try { cacheDelete(cacheKey('pointgate','properties','v2')) } catch {}

  res.json({ ok: true, toFix: toFix.length, ...results })
}
