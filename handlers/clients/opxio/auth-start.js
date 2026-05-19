// ─── auth-start.js ────────────────────────────────────────────────────────
// GET /api/clients/opxio/auth/start?token=<widget_token>
// Initiates Notion OAuth flow for QC reviewers.
//
// Flow:
//   1. Validate widget token (Supabase)
//   2. Encode state = base64url(JSON.stringify({ token, ts }))
//   3. Redirect → Notion OAuth authorize URL

import { getClientByToken } from '../../../lib/supabase.js'

const CLIENT_ID    = () => process.env.NOTION_OAUTH_CLIENT_ID
const REDIRECT_URI = 'https://api.opxio.io/api/clients/opxio/auth/callback'

export async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const token = req.query.token
  if (!token) return res.status(400).send('Missing widget token')

  const client = await getClientByToken(token)
  if (!client) return res.status(403).send('Invalid widget token')

  if (!CLIENT_ID()) {
    return res.status(500).send('OAuth not configured — set NOTION_OAUTH_CLIENT_ID in Railway')
  }

  // Encode widget token in state so callback can restore it
  const state = Buffer.from(JSON.stringify({ token, ts: Date.now() })).toString('base64url')

  const url = new URL('https://api.notionhq.com/oauth/authorize')
  url.searchParams.set('client_id',     CLIENT_ID())
  url.searchParams.set('redirect_uri',  REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('owner',         'user')
  url.searchParams.set('state',         state)

  return res.redirect(url.toString())
}
