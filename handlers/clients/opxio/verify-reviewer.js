// ─── verify-reviewer.js ────────────────────────────────────────────────────
// POST /api/opxio/verify-reviewer?token=<widget_token>
// Body: { email }
//
// 1. Validates widget token
// 2. Lists all Notion workspace members via /v1/users — confirms email
//    belongs to a real workspace member (not just any string)
// 3. Queries Team & Staff Directory DB for a record where:
//    Email = input email  AND  QC Reviewer = true
// 4. If found → issues a signed session token (8h TTL)
//
// To grant reviewer access: open Team & Staff Directory in Notion,
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

// Confirm email is a real workspace member via /v1/users
async function isWorkspaceMember(email, notionKey) {
  let hasMore = true, cursor
  while (hasMore) {
    const url = cursor
      ? `https://api.notion.com/v1/users?page_size=100&start_cursor=${cursor}`
      : 'https://api.notion.com/v1/users?page_size=100'
    const r = await fetch(url, { headers: hdrs(notionKey) })
    if (!r.ok) throw new Error(`Failed to list workspace users: ${await r.text()}`)
    const d = await r.json()
    for (const u of d.results || []) {
      if (u?.person?.email?.toLowerCase() === email) return true
    }
    hasMore = d.has_more
    cursor  = d.next_cursor
  }
  return false
}

// Query Team DB for a record with matching email AND QC Reviewer = true
async function isApprovedReviewer(email, notionKey) {
  const r = await fetch(`https://api.notion.com/v1/databases/${TEAM_DB}/query`, {
    method: 'POST',
    headers: hdrs(notionKey),
    body: JSON.stringify({
      filter: {
        and: [
          { property: 'Email',       email:    { equals: email } },
          { property: 'QC Reviewer', checkbox: { equals: true  } },
        ],
      },
      page_size: 1,
    }),
  })
  if (!r.ok) throw new Error(`Team DB query failed: ${await r.text()}`)
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
    // 1. Must be a real workspace member
    const member = await isWorkspaceMember(normalised, notionKey)
    if (!member) {
      return res.status(403).json({
        error: 'This email is not a member of the connected Notion workspace.',
      })
    }

    // 2. Must have QC Reviewer ticked in Team Directory
    const approved = await isApprovedReviewer(normalised, notionKey)
    if (!approved) {
      return res.status(403).json({
        error: 'You are not listed as a QC Reviewer. Ask your workspace admin to enable access in the Team Directory.',
      })
    }

    // 3. Issue session
    const session = signSession(normalised, client.id)
    return res.status(200).json({ ok: true, session, email: normalised })

  } catch (err) {
    console.error('[verify-reviewer]', err)
    return res.status(500).json({ error: err.message || 'Verification failed' })
  }
}
