// pages/api/proposals/[id].js
// GET  — fetch proposal data from Notion
// PATCH — save edited fields back to Notion

import { getPage, patchPage, plain } from "../../../lib/notion"
import { fetchProposalData } from "../../../lib/pdf"

export async function handler(req, res) {
  const rawId = req.query.id
  if (!rawId) return res.status(400).json({ error: "Missing id" })
  const pageId = rawId.replace(/-/g, "")
  const token  = process.env.NOTION_API_KEY

  // ── GET — return structured proposal data ─────────────────────────────────
  if (req.method === "GET") {
    try {
      const data = await fetchProposalData(pageId, token)
      return res.status(200).json(data)
    } catch (e) {
      console.error("[proposals/GET]", e.message)
      return res.status(500).json({ error: e.message })
    }
  }

  // ── PATCH — save fields back to Notion ────────────────────────────────────
  if (req.method === "PATCH") {
    try {
      const body = req.body || {}
      const patch = {}

      // Text fields — rich_text
      if (body.situation !== undefined) {
        patch["Situation"] = { rich_text: [{ text: { content: body.situation || "" } }] }
      }
      if (body.problems_solved !== undefined) {
        patch["Problems Solved"] = { rich_text: [{ text: { content: body.problems_solved || "" } }] }
      }
      if (body.goals !== undefined) {
        patch["Goals"] = { rich_text: [{ text: { content: body.goals || "" } }] }
      }

      // Select fields
      if (body.os_type !== undefined) {
        patch["OS Type"] = { select: body.os_type ? { name: body.os_type } : null }
      }

      // Number fields
      if (body.fee !== undefined) {
        patch["Fee"] = { number: Number(body.fee) || null }
      }

      // Date fields
      if (body.valid_until !== undefined) {
        patch["Valid Until"] = { date: body.valid_until ? { start: body.valid_until } : null }
      }
      if (body.issue_date !== undefined) {
        patch["Date"] = { date: body.issue_date ? { start: body.issue_date } : null }
      }

      // Custom fields (stored as rich_text in Notion)
      if (body.timeline !== undefined) {
        patch["Timeline"] = { rich_text: [{ text: { content: body.timeline || "" } }] }
      }
      if (body.notion_plan !== undefined) {
        patch["Notion Plan"] = { rich_text: [{ text: { content: body.notion_plan || "" } }] }
      }
      if (body.install_tier !== undefined) {
        patch["Install Tier"] = { rich_text: [{ text: { content: body.install_tier || "" } }] }
      }
      if (body.retainer !== undefined) {
        patch["Retainer"] = { select: body.retainer ? { name: body.retainer } : null }
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "No patchable fields in body" })
      }

      await patchPage(pageId, patch, token)
      return res.status(200).json({ ok: true, patched: Object.keys(patch) })
    } catch (e) {
      console.error("[proposals/PATCH]", e.message)
      return res.status(500).json({ error: e.message })
    }
  }

  return res.status(405).json({ error: "Method not allowed" })
}