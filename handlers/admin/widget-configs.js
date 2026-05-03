// handlers/admin/widget-configs.js
// CRUD for widget visual configs stored in Supabase widget_configs table
// Auth: x-admin-key header or ?adminKey= query param (matches ADMIN_KEY env var)

import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  })
}

function isAuthorized(req) {
  const key = req.query.adminKey || req.headers['x-admin-key'] || ''
  const expected = process.env.ADMIN_KEY || ''
  return expected && key === expected
}

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-key')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' })

  const sb = getSupabase()
  const { clientId } = req.params

  // GET /api/admin/widget-configs — list all
  // GET /api/admin/widget-configs/:clientId — get one
  if (req.method === 'GET') {
    if (clientId) {
      const { data, error } = await sb
        .from('widget_configs')
        .select('*')
        .eq('client_id', clientId)
        .order('widget_type')
      if (error) return res.status(500).json({ error: error.message })
      return res.json(data)
    }
    const { data, error } = await sb
      .from('widget_configs')
      .select('*')
      .order('client_id')
    if (error) return res.status(500).json({ error: error.message })
    return res.json(data)
  }

  // PUT /api/admin/widget-configs/:clientId — upsert config for a client+widget
  if (req.method === 'PUT') {
    if (!clientId) return res.status(400).json({ error: 'clientId required' })
    const { widget_type = 'crm-pipeline', config } = req.body
    if (!config) return res.status(400).json({ error: 'config required' })

    const { data, error } = await sb
      .from('widget_configs')
      .upsert(
        { client_id: clientId, widget_type, config, updated_at: new Date().toISOString() },
        { onConflict: 'client_id,widget_type' }
      )
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })
    return res.json(data)
  }

  // DELETE /api/admin/widget-configs/:clientId?widget_type=crm-pipeline
  if (req.method === 'DELETE') {
    if (!clientId) return res.status(400).json({ error: 'clientId required' })
    const widget_type = req.query.widget_type || 'crm-pipeline'
    const { error } = await sb
      .from('widget_configs')
      .delete()
      .eq('client_id', clientId)
      .eq('widget_type', widget_type)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
