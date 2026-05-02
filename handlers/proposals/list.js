// pages/api/proposals/list.js
// GET — returns all proposals from the Proposals DB for the index page
// Fetches company names in parallel to avoid N+1 on the frontend

import { queryDB, getPage, plain, getProp, DB, hdrs } from "../../lib/notion.js"

export async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end()

  const token = process.env.NOTION_API_KEY

  try {
    // 1. Query all proposals, newest first
    const rows = await queryDB(
      DB.PROPOSALS,
      undefined,
      token
    )

    // 2. Collect unique company relation IDs
    const companyIds = []
    const companyIdSet = new Set()
    for (const row of rows) {
      const rels = row.properties?.Company?.relation || []
      if (rels.length) {
        const id = rels[0].id.replace(/-/g, "")
        if (!companyIdSet.has(id)) { companyIdSet.add(id); companyIds.push(id) }
      }
    }

    // 3. Batch-fetch company names in parallel
    const companyMap = {}
    await Promise.all(
      companyIds.map(async id => {
        try {
          const page = await getPage(id, token)
          const name = plain(
            page.properties?.["Company Name"]?.title ||
            page.properties?.["Name"]?.title ||
            []
          )
          companyMap[id] = name || "—"
        } catch { companyMap[id] = "—" }
      })
    )

    // 4. Shape the list
    const proposals = rows.map(row => {
      const pp = row.properties || {}

      // Title / ref number
      let refNo = ""
      for (const v of Object.values(pp)) {
        if (v.type === "title") { refNo = plain(v.title); break }
      }

      const companyRelId = (pp.Company?.relation?.[0]?.id || "").replace(/-/g, "")
      const companyName  = companyMap[companyRelId] || plain(pp["Company Name"]?.rich_text || []) || "—"
      const osType       = pp["OS Type"]?.select?.name || ""
      const fee          = pp["Fee"]?.number ?? null
      const status       = pp["Status"]?.status?.name || pp["Status"]?.select?.name || "Draft"
      const issueDate    = pp["Date"]?.date?.start || row.created_time?.split("T")[0] || ""
      const validUntil   = pp["Valid Until"]?.date?.start || ""
      const pdfUrl       = pp["PDF URL"]?.url || pp["Proposal PDF"]?.url || null
      const dealRel      = (pp.Deal?.relation?.[0]?.id || "").replace(/-/g, "")

      return {
        id:          row.id.replace(/-/g, ""),
        ref:         refNo || `PRO-${row.id.slice(0, 4).toUpperCase()}`,
        company:     companyName,
        os_type:     osType,
        fee,
        status,
        issue_date:  issueDate,
        valid_until: validUntil,
        pdf_url:     pdfUrl,
        deal_id:     dealRel,
        notion_url:  `https://notion.so/${row.id.replace(/-/g, "")}`,
        last_edited: row.last_edited_time || "",
      }
    })

    // Sort: newest issue_date first, fallback to last_edited
    proposals.sort((a, b) => {
      const da = a.issue_date || a.last_edited
      const db_ = b.issue_date || b.last_edited
      return da < db_ ? 1 : -1
    })

    res.setHeader("Cache-Control", "no-store")
    return res.status(200).json({ proposals })
  } catch (e) {
    console.error("[proposals/list]", e.message)
    return res.status(500).json({ error: e.message })
  }
}