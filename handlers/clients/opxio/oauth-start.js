// ─── oauth-start.js ────────────────────────────────────────────────────────
// GET /api/opxio/oauth/start?token=<widget_token>
//
// Validates the widget token, builds the Notion OAuth URL with a signed
// state param, and returns it as JSON (widget opens it in a new tab).
//
// Required env vars:
//   NOTION_OAUTH_CLIENT_ID
//   NOTION_OAUTH_REDIRECT_URI  (e.g. https://api.opxio.io/api/opxio/oauth/callback)
//   JWT_SECRET

import { getClientByToken } from '../../../lib/supabase.js'
import { signSession }      from '../../../lib/session.js'
import { createHmac }       from 'crypto'

const NOTION_AUTH_URL = 'https://api.notion.com/v1/oauth/authorize'

// State = base64url({ token, nonce }) — ties the OAuth callback back to the
// specific client token so we know whose Settings DB to check.
function buildState(token) {
  const nonce = Math.random().toString(36).slice(2)
  return Buffer.from(JSON.stringify({ token, nonce })).toString('base64url')
}

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })

  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })

  const clientId   = process.env.NOTION_OAUTH_CLIENT_ID
  const redirectUri = process.env.NOTION_OAUTH_REDIRECT_URI
  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: 'OAuth not configured — NOTION_OAUTH_CLIENT_ID / NOTION_OAUTH_REDIRECT_URI missing' })
  }

  const state   = buildState(token)
  const authUrl = `${NOTION_AUTH_URL}?client_id=${clientId}&response_type=code&owner=user&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`

  return res.status(200).json({ authUrl })
}
