// handlers/clients/pointgate/notify-overdue.js
// POST /api/clients/pointgate/notify-overdue  (protected by NOTIFY_SECRET)
// Also called by node-cron daily at 09:00 MYT
//
// Logic:
//   - Find payments where status != Paid and due date exists
//   - 14d overdue → send first notice (if "Notice 14d Sent" not set)
//   - 21d overdue → send stricter notice (if "Notice 21d Sent" not set)
//   - Look up tenant phone from Tenants DB
//   - Send via Meta WhatsApp Cloud API using approved templates
//   - Write sent date back to payment page

import { queryDB, plain, hdrs } from '../../../lib/notion.js'
import { cacheDelete, cacheKey } from '../../../lib/cache.js'

const NOTION_KEY  = () => process.env.POINTGATE_NOTION_KEY || process.env.NOTION_API_KEY
const WA_TOKEN    = () => process.env.WHATSAPP_TOKEN          // Meta System User token
const WA_PHONE_ID = () => process.env.WHATSAPP_PHONE_ID       // Meta phone number ID
const NOTIFY_SECRET = process.env.POINTGATE_NOTIFY_SECRET || 'pointgate-notify'

const PG = {
  PAYMENTS: 'cdc0a5b7e9384afabdc83cb24004f6f8',
  TENANTS:  '11bc170f3fc643b2b0e12ef9ef712300',
}

// WhatsApp template names — create & approve these in Meta Business Manager
const TEMPLATE_14D = 'pointgate_overdue_14d'
const TEMPLATE_21D = 'pointgate_overdue_21d'
const TEMPLATE_LANG = 'en'

// ── WhatsApp sender ────────────────────────────────────────────────────────

async function sendWhatsApp(to, templateName, params) {
  const token   = WA_TOKEN()
  const phoneId = WA_PHONE_ID()
  if (!token || !phoneId) throw new Error('WhatsApp credentials not configured')

  // Normalise number: strip +, spaces, dashes
  const num = to.replace(/[\s\-+]/g, '')

  const body = {
    messaging_product: 'whatsapp',
    to:   num,
    type: 'template',
    template: {
      name:     templateName,
      language: { code: TEMPLATE_LANG },
      components: [{
        type: 'body',
        parameters: params.map(text => ({ type: 'text', text: String(text) })),
      }],
    },
  }

  const res = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp API ${res.status}: ${err}`)
  }
  return res.json()
}

// ── Notion write-back ──────────────────────────────────────────────────────

async function markNoticeSent(pageId, field, token) {
  const today = new Date().toISOString().substring(0, 10)
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method:  'PATCH',
    headers: hdrs(token),
    body: JSON.stringify({
      properties: {
        [field]: { date: { start: today } },
      },
    }),
  })
}

// ── Main logic ─────────────────────────────────────────────────────────────

export async function runNotifyOverdue(token) {
  const today     = new Date()
  today.setHours(0, 0, 0, 0)
  const results   = { sent14: [], sent21: [], skipped: [], errors: [] }

  // Fetch all unpaid payments (filter: status != Paid)
  const payments = await queryDB(PG.PAYMENTS, {
    property: 'Status',
    select: { does_not_equal: 'Paid' },
  }, token)

  // Fetch tenant phone map: tenantId → phone
  const tenantPages = await queryDB(PG.TENANTS, undefined, token)
  const phoneMap = {}
  for (const p of tenantPages) {
    const id    = p.id.replace(/-/g, '')
    const phone = p.properties['Phone']?.phone_number || ''
    const name  = plain(p.properties['Full Name']?.title || []) || ''
    if (phone) phoneMap[id] = { phone, name }
  }

  for (const page of payments) {
    const p         = page.properties
    const pageId    = page.id
    const dueStr    = p['Due Date']?.date?.start || null
    if (!dueStr) { results.skipped.push({ pageId, reason: 'no due date' }); continue }

    const dueDate   = new Date(dueStr + 'T00:00:00')
    const daysOver  = Math.floor((today - dueDate) / 86400000)
    if (daysOver < 14) continue   // not yet 14 days overdue

    // Get tenant
    const tenRels  = (p['Tenant']?.relation || []).map(r => r.id.replace(/-/g, ''))
    const tenantId = tenRels[0] || ''
    const tenInfo  = phoneMap[tenantId]
    if (!tenInfo) { results.skipped.push({ pageId, reason: 'no phone' }); continue }

    // Get lot + amount
    const propRels = (p['Property']?.relation || []).map(r => r.id.replace(/-/g, ''))
    const amtDue   = p['Amount Due (RM)']?.number ?? 0
    const amtPaid  = p['Paid']?.number            ?? 0
    const balance  = amtDue - amtPaid

    // Determine which notice to send
    const sent14   = p['Notice 14d Sent']?.date?.start
    const sent21   = p['Notice 21d Sent']?.date?.start
    const month    = p['Payment Month']?.date?.start?.substring(0, 7) || dueStr.substring(0, 7)

    try {
      if (daysOver >= 21 && !sent21) {
        // 21-day strict notice
        // Template params: {{1}} name, {{2}} lot/month, {{3}} balance, {{4}} days
        await sendWhatsApp(tenInfo.phone, TEMPLATE_21D, [
          tenInfo.name,
          month,
          `RM ${balance.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`,
          String(daysOver),
        ])
        await markNoticeSent(pageId, 'Notice 21d Sent', token)
        results.sent21.push({ pageId, tenant: tenInfo.name, phone: tenInfo.phone, daysOver })
        console.log(`[notify] 21d sent → ${tenInfo.name} (${tenInfo.phone}) +${daysOver}d`)

      } else if (daysOver >= 14 && !sent14) {
        // 14-day reminder
        await sendWhatsApp(tenInfo.phone, TEMPLATE_14D, [
          tenInfo.name,
          month,
          `RM ${balance.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`,
          String(daysOver),
        ])
        await markNoticeSent(pageId, 'Notice 14d Sent', token)
        results.sent14.push({ pageId, tenant: tenInfo.name, phone: tenInfo.phone, daysOver })
        console.log(`[notify] 14d sent → ${tenInfo.name} (${tenInfo.phone}) +${daysOver}d`)
      }
    } catch (e) {
      console.error(`[notify] failed for ${tenInfo.name}:`, e.message)
      results.errors.push({ pageId, tenant: tenInfo.name, error: e.message })
    }
  }

  return results
}

// ── HTTP handler ───────────────────────────────────────────────────────────

export async function handler(req, res) {
  // Protect with secret key
  const secret = req.headers['x-notify-secret'] || req.query.secret
  if (secret !== NOTIFY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const token   = NOTION_KEY()
    const results = await runNotifyOverdue(token)
    res.json({
      ok: true,
      sent14:   results.sent14.length,
      sent21:   results.sent21.length,
      skipped:  results.skipped.length,
      errors:   results.errors.length,
      details:  results,
      ts:       new Date().toISOString(),
    })
  } catch (err) {
    console.error('[notify-overdue] error:', err.message)
    res.status(500).json({ error: err.message })
  }
}
