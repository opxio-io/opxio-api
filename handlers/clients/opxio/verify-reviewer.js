// ─── verify-reviewer.js ────────────────────────────────────────────────────
// POST /api/opxio/verify-reviewer?token=<widget_token>
// Body: { email }
//
// Validates widget token, then queries Team Directory for a record where:
//   Email = input email  AND  QC Reviewer = true
//
// If found → issues a signed session token (8h TTL).
//
// To grant reviewer access: open Team Directory in Notion,
// find the team member, tick the "QC Reviewer" checkbox.
//
// Required env vars: NOTION_API_KEY, JWT_SECRET

import { getClientByToken, getNotionToken } from '../../../lib/supabase.js'
import { signSession }                      from '../../../lib/session.js'

const TEAM_DB = '345fe60097f68105b7bfc34e6a298e87'

function hdrs(key) {
  return {
    Authorization:    `Bearer ${key}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  }
}

// Query Team Directory for a record with matching email AND QC Reviewer = true
async function isApprovedReviewer(email, notionKey) {
  const r = await fetch(`https://api.notion.com/v1/databases/${TEAM_DB}/query`, {
    method: 'POST',
    headers: hdrs(notionKey),
    body: JSON.stringify({
      filter: {
        and: [
          { property: 'Email', rich_text: { contains: email } },
          { property: 'QC Reviewer', checkbox: { equals: true } },
        ],
      },
      page_size: 1,
    }),
  })
  if (!r.ok) throw new Error(`Team Directory query failed: ${await r.text()}`)
  const d = await r.json()
  return (d.results?.length || 0) > 0
}

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })
  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })

  const { email } = req.body || {}
  if (!email || !email.includes('@'))
    return res.status(400).json({ error: 'Valid email required' })

  const normalised = email.trim().toLowerCase()
  const notionKey  = getNotionToken(client)

  try {
    const approved = await isApprovedReviewer(normalised, notionKey)
    if (!approved) {
      return res.status(403).json({
        error: 'Not authorised. Ask your workspace admin to enable QC Reviewer access in the Team Directory.',
      })
    }

    const session = signSession(normalised, client.id)
    return res.status(200).json({ ok: true, session, email: normalised })

  } catch (err) {
    console.error('[verify-reviewer]', err)
    return res.status(500).json({ error: err.message || 'Verification failed' })
  }
}
