// pages/api/client/info.js
// Returns basic client identity for widgets (client name, slug).
// Called by widgets on load to set the eyebrow without needing ?client= in the URL.

import { getClientByToken } from '../../lib/supabase.js'
import { CLIENT_INFO } from '../../lib/demo-fixtures.js'

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')

  if (req.method === 'OPTIONS') return res.status(200).end()

  const token = req.query.token || req.headers['x-widget-token']
  if (!token) return res.status(401).json({ error: 'Missing token' })

  const client = await getClientByToken(token)
  if (!client) return res.status(403).json({ error: 'Invalid token' })

  if (client.slug === 'demo') return res.status(200).json(CLIENT_INFO)

  return res.status(200).json({
    client: client.client_name || client.slug || '',
    slug:   client.slug || '',
  })
}