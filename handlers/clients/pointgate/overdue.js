// handlers/clients/pointgate/overdue.js
// GET  /api/clients/pointgate/overdue         — unpaid past-due payments, grouped by lot
// POST /api/clients/pointgate/overdue/send    — send WhatsApp to specific payment record

import { queryDB, plain, hdrs } from '../../../lib/notion.js'
import { cacheGet, cacheSet, cacheKey, cacheDelete } from '../../../lib/cache.js'

const NOTION_KEY    = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY
const WA_TOKEN      = () => process.env.WHATSAPP_TOKEN
const WA_PHONE_ID   = () => process.env.WHATSAPP_PHONE_ID
const NOTIFY_SECRET = process.env.POINTGATE_NOTIFY_SECRET || 'pointgate-notify'

const PG = {
  PAYMENTS:   'cdc0a5b7e9384afabdc83cb24004f6f8',
  TENANTS:    '11bc170f3fc643b2b0e12ef9ef712300',
  PROPERTIES: '979e0918c8db459694657c30743c4846',
}

const TEMPLATE_14D = 'pointgate_overdue_14d'
const TEMPLATE_21D = 'pointgate_overdue_21d'
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const CK = cacheKey('pointgate', 'overdue', 'v2')

function tier(d) {
  if (d >= 60) return 'critical'
  if (d >= 30) return 'severe'
  if (d >= 21) return 'urgent'
  if (d >= 14) return 'warning'
  if (d >= 7)  return 'notice'
  return 'recent'
}

async function fetchAll(token) {
  const cached = cacheGet(CK)
  if (cached) return cached

  // Fetch ALL payments so we can build lotTenantMap from paid records too
  const [allPayments, tenantPages, propPages] = await Promise.all([
    queryDB(PG.PAYMENTS, undefined, token),
    queryDB(PG.TENANTS, undefined, token),
    queryDB(PG.PROPERTIES, undefined, token),
  ])

  // propMap: propId → lot name
  const propMap = {}
  for (const p of propPages) {
    propMap[p.id.replace(/-/g,'')] = plain(p.properties['Property Name']?.title || []) || ''
  }

  // tenantMap: tenantId → { name, phone }
  // propToTenants: propId → [tenantId] (from Tenant.Property DUAL relation)
  const tenantMap = {}, propToTenants = {}
  for (const p of tenantPages) {
    const id = p.id.replace(/-/g,'')
    tenantMap[id] = {
      name:  plain(p.properties['Full Name']?.title || []) || '',
      phone: p.properties['Phone']?.phone_number || '',
    }
    const propRels = (p.properties['Property']?.relation || []).map(r => r.id.replace(/-/g,''))
    for (const propId of propRels) {
      if (!propToTenants[propId]) propToTenants[propId] = []
      propToTenants[propId].push(id)
    }
  }

  // lotTenantMap: lot → tenantId (from any payment that has a Tenant relation)
  const lotTenantMap = {}
  for (const page of allPayments) {
    const p = page.properties
    const tenRels = (p['Tenant']?.relation || []).map(r => r.id.replace(/-/g,''))
    if (!tenRels[0]) continue
    const propRels = (p['Property']?.relation || []).map(r => r.id.replace(/-/g,''))
    const propId = propRels[0] || ''
    const lot = propMap[propId] || ''
    if (lot && !lotTenantMap[lot]) lotTenantMap[lot] = tenRels[0]
  }

  const today = new Date(); today.setHours(0,0,0,0)
  const rows = []

  for (const page of allPayments) {
    const p = page.properties
    const status = p['Status']?.select?.name || p['Status']?.status?.name || ''
    if (status === 'Paid') continue

    const dueStr = p['Due Date']?.date?.start || null
    if (!dueStr) continue
    const dueDate  = new Date(dueStr + 'T00:00:00')
    const daysOver = Math.floor((today - dueDate) / 86400000)
    if (daysOver <= 0) continue

    const propRels = (p['Property']?.relation || []).map(r => r.id.replace(/-/g,''))
    const propId   = propRels[0] || ''
    const lot      = propMap[propId] || '—'

    // Three-tier tenant resolution (same as dashboard)
    const tenRels  = (p['Tenant']?.relation || []).map(r => r.id.replace(/-/g,''))
    const tenantId = tenRels[0]
      || (propId && propToTenants[propId]?.length === 1 ? propToTenants[propId][0] : null)
      || (lot !== '—' ? lotTenantMap[lot] : null)
      || ''
    const ten = tenantMap[tenantId] || { name: '', phone: '' }

    const amtDue  = p['Amount Due (RM)']?.number ?? 0
    const amtPaid = p['Paid']?.number            ?? 0
    const bf      = p['Balance B/F (RM)']?.number ?? 0
    const balance = bf + amtDue - amtPaid

    const monthStr   = p['Payment Month']?.date?.start?.substring(0,7) || ''
    const [yr, mo]   = monthStr.split('-').map(Number)
    const monthLabel = mo ? `${MONTHS[mo-1]} ${yr}` : monthStr

    const sent14  = p['Notice 14d Sent']?.date?.start  || null
    const sent21  = p['Notice 21d Sent']?.date?.start  || null
    const method  = p['Payment Method']?.select?.name  || ''
    const payDate = p['Payment Date']?.date?.start     || null

    rows.push({
      id: page.id,
      lot, propId, tenantId,
      tenant: ten.name,
      phone:  ten.phone,
      monthStr, monthLabel, dueDate: dueStr,
      amtDue, amtPaid, bf, balance,
      daysOver, status, method, payDate,
      sent14, sent21,
      tier: tier(daysOver),
    })
  }

  rows.sort((a, b) => b.daysOver - a.daysOver)

  // Group by lot (propId)
  const groupMap = {}
  for (const r of rows) {
    const key = r.lot !== '—' ? r.lot : r.id
    if (!groupMap[key]) {
      groupMap[key] = {
        lot: r.lot, propId: r.propId,
        tenant: r.tenant, phone: r.phone, tenantId: r.tenantId,
        months: [],
        totalBalance: 0,
        worstDaysOver: 0,
        tier: r.tier,
        worstPageId: r.id,
      }
    }
    const g = groupMap[key]
    g.months.push(r)
    g.totalBalance += r.balance
    if (r.daysOver > g.worstDaysOver) {
      g.worstDaysOver = r.daysOver
      g.tier = r.tier
      g.worstPageId = r.id
      // Keep best tenant name if this month has one
      if (r.tenant && !g.tenant) { g.tenant = r.tenant; g.phone = r.phone; g.tenantId = r.tenantId }
    }
  }

  const groups = Object.values(groupMap)
  groups.sort((a, b) => b.worstDaysOver - a.worstDaysOver)

  const TIER_KEYS = ['critical','severe','urgent','warning','notice','recent']
  const summary = Object.fromEntries(TIER_KEYS.map(k => [k, groups.filter(g=>g.tier===k).length]))
  summary.total = groups.length
  summary.totalBalance = groups.reduce((s,g)=>s+g.totalBalance, 0)

  const data = { groups, rows, summary, ts: new Date().toISOString() }
  cacheSet(CK, data)
  return data
}

// ── WhatsApp ───────────────────────────────────────────────────────────────

async function sendWA(to, templateName, params) {
  const token = WA_TOKEN(), phoneId = WA_PHONE_ID()
  if (!token || !phoneId) throw new Error('WhatsApp not configured — add WHATSAPP_TOKEN and WHATSAPP_PHONE_ID to Railway env')
  const num = to.replace(/[\s\-+]/g,'')
  const r = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: num, type: 'template',
      template: {
        name: templateName, language: { code: 'en' },
        components: [{ type:'body', parameters: params.map(t=>({type:'text',text:String(t)})) }],
      },
    }),
  })
  if (!r.ok) { const e = await r.text(); throw new Error(`WA ${r.status}: ${e}`) }
  return r.json()
}

async function markNoticeSent(pageId, field, token) {
  const today = new Date().toISOString().substring(0,10)
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH', headers: hdrs(token),
    body: JSON.stringify({ properties: { [field]: { date: { start: today } } } }),
  })
}

// ── GET /overdue ───────────────────────────────────────────────────────────

export async function listHandler(req, res) {
  try {
    const token = NOTION_KEY()
    if (req.query._t) cacheDelete(CK)
    const data = await fetchAll(token)
    res.json({ ok: true, ...data })
  } catch (err) {
    console.error('[overdue] list error:', err.message)
    res.status(500).json({ error: err.message })
  }
}

// ── POST /overdue/send ─────────────────────────────────────────────────────

export async function sendHandler(req, res) {
  const secret = req.headers['x-notify-secret'] || req.query.secret
  if (secret !== NOTIFY_SECRET) return res.status(401).json({ error: 'Unauthorized' })

  const { pageId, forceTemplate } = req.body || {}
  if (!pageId) return res.status(400).json({ error: 'pageId required' })

  try {
    const token = NOTION_KEY()
    const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: hdrs(token) })
    if (!pageRes.ok) throw new Error(`Notion page fetch failed: ${pageRes.status}`)
    const page = await pageRes.json()
    const p    = page.properties

    const dueStr   = p['Due Date']?.date?.start
    if (!dueStr) return res.status(400).json({ error: 'No due date on this record' })
    const today    = new Date(); today.setHours(0,0,0,0)
    const daysOver = Math.floor((today - new Date(dueStr+'T00:00:00')) / 86400000)

    const tenRels  = (p['Tenant']?.relation || []).map(r => r.id.replace(/-/g,''))
    const tenantId = tenRels[0] || ''
    if (!tenantId) return res.status(400).json({ error: 'No tenant linked to this payment' })

    const tenRes  = await fetch(`https://api.notion.com/v1/pages/${tenantId}`, { headers: hdrs(token) })
    const tenPage = await tenRes.json()
    const phone = tenPage.properties['Phone']?.phone_number || ''
    const name  = plain(tenPage.properties['Full Name']?.title || []) || ''
    if (!phone) return res.status(400).json({ error: 'Tenant has no phone number in Notion' })

    const amtDue   = p['Amount Due (RM)']?.number ?? 0
    const amtPaid  = p['Paid']?.number ?? 0
    const bf       = p['Balance B/F (RM)']?.number ?? 0
    const balance  = bf + amtDue - amtPaid
    const monthStr = p['Payment Month']?.date?.start?.substring(0,7) || dueStr.substring(0,7)
    const balFmt   = `RM ${balance.toLocaleString('en-MY',{minimumFractionDigits:2})}`

    let templateName, noticeField
    if (forceTemplate === '21d' || (!forceTemplate && daysOver >= 21)) {
      templateName = TEMPLATE_21D; noticeField = 'Notice 21d Sent'
    } else {
      templateName = TEMPLATE_14D; noticeField = 'Notice 14d Sent'
    }

    await sendWA(phone, templateName, [name, monthStr, balFmt, String(daysOver)])
    await markNoticeSent(pageId, noticeField, token)
    cacheDelete(CK)

    res.json({ ok: true, sent: { to: phone, name, template: templateName, daysOver } })
  } catch (err) {
    console.error('[overdue/send]', err.message)
    res.status(500).json({ error: err.message })
  }
}
