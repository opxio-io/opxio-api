// POST /api/portal/feedback|expansion|message
// GET  /api/portal/download?type=invoice|receipt&id=xxx
// Token validated via Supabase clients table

import { getPage, createPage, plain, DB } from '../../../lib/notion'
import { createClient as createSupabaseClient } from "@supabase/supabase-js"

async function getProjectIdFromToken(portalToken) {
  if (!portalToken) return null
  try {
    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
    )
    const { data } = await supabase
      .from('clients')
      .select('project_id')
      .eq('portal_token', portalToken)
      .single()
    return data?.project_id || null
  } catch { return null }
}

async function notify(subject, body) {
  if (!process.env.RESEND_API_KEY) { console.log('[portal]', subject); return }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Opxio Portal <hello@opxio.io>', to: 'hello@opxio.io', subject, text: body }),
  }).catch(e => console.warn('[portal notify]', e.message))
}

export async function handler(req, res) {
  const { action } = req.query
  const nToken = process.env.NOTION_API_KEY
  const today  = new Date().toISOString().split('T')[0]

  // ── FEEDBACK ──────────────────────────────────────────────────────────────
  if (action === 'feedback') {
    if (req.method !== 'POST') return res.status(405).end()
    const { portal_token, phase_name, type, description, attachment } = req.body || {}
    if (!description) return res.status(400).json({ error: 'Description required' })
    const project_id = await getProjectIdFromToken(portal_token)
    try {
      await createPage({
        parent: { database_id: DB.CLIENT_IMPL },
        properties: {
          'Name': { title: [{ text: { content: `${type||'Feedback'} — ${phase_name||'Portal'}` } }] },
          ...(project_id ? { 'Project Tracker': { relation: [{ id: project_id }] } } : {}),
          'Notes': { rich_text: [{ text: { content: `Phase: ${phase_name||'N/A'}\nType: ${type}\n\n${description}${attachment?`\n\nAttachment: ${attachment}`:''}` } }] },
          'Date': { date: { start: today } },
          'Source': { select: { name: 'Client Portal' } },
        }
      }, nToken)
      await notify(`[Portal] ${type} — ${phase_name}`, `Project: ${project_id}\nPhase: ${phase_name}\nType: ${type}\n\n${description}`)
      return res.json({ ok: true })
    } catch (e) { console.error('[portal/feedback]', e); return res.status(500).json({ error: e.message }) }
  }

  // ── EXPANSION ─────────────────────────────────────────────────────────────
  if (action === 'expansion') {
    if (req.method !== 'POST') return res.status(405).end()
    const { portal_token, description, area, urgency } = req.body || {}
    if (!description) return res.status(400).json({ error: 'Description required' })
    const project_id = await getProjectIdFromToken(portal_token)
    try {
      let companyId = null
      if (project_id) {
        try { const p = await getPage(project_id, nToken); companyId = p.properties.Company?.relation?.[0]?.id?.replace(/-/g,'') || null } catch {}
      }
      await createPage({
        parent: { database_id: DB.EXPANSIONS },
        properties: {
          'Name': { title: [{ text: { content: `Expansion Request — ${area||'General'}` } }] },
          ...(project_id ? { 'Project': { relation: [{ id: project_id }] } } : {}),
          ...(companyId  ? { 'Company': { relation: [{ id: companyId }] } } : {}),
          'Notes': { rich_text: [{ text: { content: `${description}\n\nUrgency: ${urgency||'When possible'}` } }] },
          'Status': { select: { name: 'Requested' } },
          'Source': { select: { name: 'Client Portal' } },
        }
      }, nToken)
      await notify(`[Portal] Expansion — ${area}`, `Project: ${project_id}\nArea: ${area}\nUrgency: ${urgency}\n\n${description}`)
      return res.json({ ok: true })
    } catch (e) { console.error('[portal/expansion]', e); return res.status(500).json({ error: e.message }) }
  }

  // ── MESSAGE ───────────────────────────────────────────────────────────────
  if (action === 'message') {
    if (req.method !== 'POST') return res.status(405).end()
    const { portal_token, subject, message } = req.body || {}
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message required' })
    const project_id = await getProjectIdFromToken(portal_token)
    try {
      let companyId = null
      if (project_id) {
        try { const p = await getPage(project_id, nToken); companyId = p.properties.Company?.relation?.[0]?.id?.replace(/-/g,'') || null } catch {}
      }
      await createPage({
        parent: { database_id: DB.ACTIVITY_LOG },
        properties: {
          'Name': { title: [{ text: { content: `Portal Message — ${subject}` } }] },
          ...(project_id ? { 'Project': { relation: [{ id: project_id }] } } : {}),
          ...(companyId  ? { 'Company': { relation: [{ id: companyId }] } } : {}),
          'Notes': { rich_text: [{ text: { content: `Subject: ${subject}\n\n${message}` } }] },
          'Date': { date: { start: today } },
          'Type': { select: { name: 'Client Portal Message' } },
        }
      }, nToken)
      await notify(`[Portal] Message — ${subject}`, `Project: ${project_id}\n\n${message}`)
      return res.json({ ok: true })
    } catch (e) { console.error('[portal/message]', e); return res.status(500).json({ error: e.message }) }
  }

  // ── DOWNLOAD ──────────────────────────────────────────────────────────────
  if (action === 'download') {
    if (req.method !== 'GET') return res.status(405).end()
    const { type, id } = req.query
    const endpoint = type === 'receipt' ? 'generate_receipt' : 'generate_invoice'
    try {
      const apiRes = await fetch(`https://api.opxio.io/api/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_id: id }),
      })
      if (!apiRes.ok) return res.status(500).json({ error: 'PDF generation failed' })
      const buffer = await apiRes.arrayBuffer()
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${type}-${id.slice(0,8)}.pdf"`)
      return res.send(Buffer.from(buffer))
    } catch (e) { return res.status(500).json({ error: e.message }) }
  }

  return res.status(404).json({ error: 'Not found' })
}