// ─── issue_final_invoice.js ────────────────────────────────────────────────
// POST /api/issue_final_invoice   { "page_id": "<project_page_id>" }
// Triggered by Notion button "Issue Final Invoice" on a Project page.
//
// 1. Reads Project → Company, Quotation, Deposit Invoice, Lead
// 2. Reads Quotation → Total Amount, Payment Terms
// 3. Creates Final Payment invoice in Invoices DB
// 4. Auto-generates Final Invoice PDF
// 5. Updates Project status → In Review
// 6. Advances Lead stage → Pending Final Payment

import { getPage, patchPage, createPage, getCurrency, plain, DB, queryDB, createLedgerEntry, createTeamTask } from "../../lib/notion"


// ── Notion API headers ─────────────────────────────────────────────────────
const hdrs = (token) => ({
  "Authorization": `Bearer ${token}`,
  "Content-Type": "application/json",
  "Notion-Version": "2022-06-28",
})

// ── Find inline Products & Services DB on an invoice page ─────────────────
async function findLineItemsDB(pageId, token) {
  try {
    const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`, {
      headers: hdrs(token),
    })
    if (!r.ok) return null
    const d = await r.json()
    for (const b of (d.results || [])) {
      if (b.type === "child_database" && /products/i.test(b.child_database?.title || "")) {
        return b.id.replace(/-/g, "")
      }
      // Check inside callout blocks
      if (["callout", "column", "column_list", "toggle"].includes(b.type)) {
        const inner = await fetch(`https://api.notion.com/v1/blocks/${b.id}/children?page_size=20`, {
          headers: hdrs(token),
        })
        if (inner.ok) {
          const id2 = await inner.json()
          for (const b2 of (id2.results || [])) {
            if (b2.type === "child_database" && /products/i.test(b2.child_database?.title || "")) {
              return b2.id.replace(/-/g, "")
            }
          }
        }
      }
    }
  } catch {}
  return null
}

// ── Ensure Products & Services inline DB exists on the invoice page ────────
async function ensureLineItemsDB(pageId, token) {
  let dbId = await findLineItemsDB(pageId, token)
  if (dbId) return dbId
  const r = await fetch("https://api.notion.com/v1/databases", {
    method:  "POST",
    headers: hdrs(token),
    body:    JSON.stringify({
      parent:    { type: "page_id", page_id: pageId },
      is_inline: true,
      title: [{ type: "text", text: { content: "Products & Services" } }],
      properties: {
        "Notes":      { title: {} },
        "Qty":        { number: { format: "number" } },
        "Unit Price": { number: { format: "number" } },
        "Product":    { relation: { database_id: DB.CATALOGUE, single_property: {} } },
      },
    }),
  })
  if (!r.ok) { console.warn("[issue_final_invoice] ensureLineItemsDB:", await r.text()); return null }
  const db = await r.json()
  dbId = db.id.replace(/-/g, "")
  console.log("[issue_final_invoice] created inline Products & Services DB:", dbId)
  return dbId
}

// ── Copy line items from Quotation → Invoice ───────────────────────────────
async function copyLineItems(quotId, invId, token) {
  try {
    const srcDbId = await findLineItemsDB(quotId, token)
    if (!srcDbId) { console.log("[issue_final_invoice] no line items DB on quotation"); return }
    const srcRows = await queryDB(srcDbId, undefined, token)
    if (!srcRows.length) { console.log("[issue_final_invoice] quotation line items empty"); return }

    const tgtDbId = await ensureLineItemsDB(invId, token)
    if (!tgtDbId) return

    for (const row of srcRows) {
      const rp          = row.properties
      const productRels = rp.Product?.relation || []
      const qty         = rp.Qty?.number || 1
      const unitPrice   = rp["Unit Price"]?.number ?? 0
      const notesText   = (rp.Notes?.title || []).map(t => t.plain_text || "").join("").trim() || ""
      const notesArr    = notesText ? [{ type: "text", text: { content: notesText } }] : []
      try {
        await createPage({
          parent: { database_id: tgtDbId },
          properties: {
            "Notes":      { title: notesArr },
            "Qty":        { number: qty },
            "Unit Price": { number: unitPrice },
            ...(productRels.length ? { "Product": { relation: [{ id: productRels[0].id }] } } : {}),
          },
        }, token)
      } catch (e) {
        console.warn("[issue_final_invoice] copyLineItems row:", e.message)
      }
    }
    console.log(`[issue_final_invoice] copied ${srcRows.length} line items to final invoice`)
  } catch (e) {
    console.warn("[issue_final_invoice] copyLineItems:", e.message)
  }
}

const API_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://api.opxio.io"

async function run(payload) {
  const rawId = payload.page_id
    || payload.data?.id           // Notion automation format
    || payload.data?.page_id
    || payload.source?.page_id
    || payload.source?.id
  if (!rawId) throw new Error("No page_id in payload")
  const projectId = rawId.replace(/-/g, "")

  const proj  = await getPage(projectId, process.env.NOTION_API_KEY)
  const props = proj.properties

  const status = props.Status?.select?.name || ""
  if (status === "Completed") throw new Error("Project already completed")

  // Gather linked IDs from Project
  const companyId       = props.Company?.relation?.[0]?.id?.replace(/-/g, "") || null
  const quotationId     = props.Quotation?.relation?.[0]?.id?.replace(/-/g, "") || null
  const depositInvId    = props.Invoice?.relation?.[0]?.id?.replace(/-/g, "") || null
  const clientAccountId = props["Client Account"]?.relation?.[0]?.id?.replace(/-/g, "") || null

  // Lead — try multiple field names
  let leadId = null
  for (const field of ["Deals", "Deal Source", "Lead"]) {
    leadId = props[field]?.relation?.[0]?.id?.replace(/-/g, "") || null
    if (leadId) break
  }

  // Get amounts from Quotation
  let totalAmount = 0, paymentTerms = "50% Deposit"
  if (quotationId) {
    try {
      const qpage = await getPage(quotationId, process.env.NOTION_API_KEY)
      totalAmount  = qpage.properties["Amount"]?.number || qpage.properties["Amount (MYR)"]?.number || 0
      paymentTerms = qpage.properties["Payment Terms"]?.select?.name || "50% Deposit"
    } catch (e) {
      console.warn("[issue_final_invoice] quotation fetch:", e.message)
    }
  }

  if (paymentTerms === "Full Upfront") {
    throw new Error("This was a Full Upfront payment — no final invoice needed")
  }

  // Get deposit amount from deposit invoice
  let depositAmt = 0
  if (depositInvId) {
    try {
      const dp = await getPage(depositInvId, process.env.NOTION_API_KEY)
      depositAmt = dp.properties["Deposit (50%)"]?.number || 0
    } catch {}
  }

  const finalPayment = depositAmt ? totalAmount - depositAmt : totalAmount * 0.5
  const today = new Date().toISOString().split("T")[0]

  // ── Create Final Payment Invoice ───────────────────────────────────────
  const invProps = {
    "Invoice No.":    { title: [{ text: { content: "" } }] },
    "Invoice Type":   { select: { name: "Final Payment" } },
    "Status":         { status: { name: "Balance Pending" } },
    "Issue Date":     { date: { start: today } },
    "Amount":         { number: totalAmount },
    ...(currency ? { "Currency": { select: { name: currency } } } : {}),
    "Final Payment":  { number: Math.round(finalPayment * 100) / 100 },
    "Payment Terms":  { select: { name: paymentTerms } },
    ...(clientAccountId ? { "Client Account": { relation: [{ id: clientAccountId }] } } : {}),
    ...(companyId   ? { "Company":        { relation: [{ id: companyId   }] } } : {}),
    ...(quotationId ? { "Quotation":      { relation: [{ id: quotationId }] } } : {}),
    ...(depositInvId ? { "Deposit Invoice": { relation: [{ id: depositInvId }] } } : {}),
    ...(leadId       ? { "Deal Source":    { relation: [{ id: leadId      }] } } : {}),
  }

  const invPage = await createPage({ parent: { database_id: DB.INVOICE }, properties: invProps }, process.env.NOTION_API_KEY)
  const invId   = invPage.id.replace(/-/g, "")
  console.log("[issue_final_invoice] Final invoice created:", invId)

  // ── Copy line items from Quotation → Final Invoice ─────────────────────
  if (quotationId) {
    copyLineItems(quotationId, invId, process.env.NOTION_API_KEY).catch(() => {})
  }

  // Link deposit invoice → this final invoice
  if (depositInvId) {
    try { await patchPage(depositInvId, { "Final Invoice": { relation: [{ id: invId }] } }, process.env.NOTION_API_KEY) } catch {}
  }

  // ── Auto-generate Final Invoice PDF ───────────────────────────────────
  let pdfUrl = ""
  try {
    const gr = await fetch(`${API_URL}/api/generate?page_id=${invId}&type=invoice`, {
      headers: { "Content-Type": "application/json" }
    })
    if (gr.ok) {
      const gd = await gr.json()
      pdfUrl = gd.pdf_url || ""
      console.log("[issue_final_invoice] PDF generated:", pdfUrl.slice(0, 60))
    } else {
      console.warn("[issue_final_invoice] PDF gen failed:", gr.status)
    }
  } catch (e) {
    console.warn("[issue_final_invoice] PDF gen:", e.message)
  }

  // ── Update Project → In Review ─────────────────────────────────────────
  try {
    await patchPage(projectId, {
      "Status":            { status: { name: "Client Review" } },
      "Final Invoice":     { relation: [{ id: invId }] },
    }, process.env.NOTION_API_KEY)
  } catch (e) {
    console.warn("[issue_final_invoice] project update:", e.message)
  }

  // ── Finance Ledger — auto-create Final Payment entry (Pending) ──────────
  // Status is "Pending" because the invoice has been issued but not yet paid.
  // When the client pays, the user updates this entry to "Received".
  let companyName = ""
  if (companyId) {
    try {
      const cp = await getPage(companyId, process.env.NOTION_API_KEY)
      for (const v of Object.values(cp.properties)) {
        if (v.type === "title") { companyName = plain(v.title); break }
      }
    } catch {}
  }
  createLedgerEntry({
    title:     companyName ? `Final Payment — ${companyName}` : "Client Final Payment",
    amount:    Math.round(finalPayment * 100) / 100,
    category:  "Client Final Payment",
    source:    "Client Payment",
    payment:   "Bank Transfer",
    status:    "Pending",
    date:      today,
    invoiceId: invId,
    projectId: projectId,
    notes:     "Auto-created when final invoice issued — update to Received when paid",
  }, process.env.NOTION_API_KEY).catch(() => {})

  // ── Auto-create Team Task — collect final payment ─────────────────────────
  await createTeamTask({
    taskName:  `Collect final payment — ${companyName || "Client"}`,
    category:  "Billing",
    priority:  "High",
    invoiceId: invId,
    projectId: projectId || undefined,
    leadId:    leadId    || undefined,
    companyId: companyId || undefined,
  })

  return {
    status:        "success",
    project_id:    projectId,
    invoice_id:    invId,
    invoice_type:  "Final Payment",
    final_payment: Math.round(finalPayment * 100) / 100,
    total_amount:  totalAmount,
    pdf_url:       pdfUrl || null,
    lead_id:       leadId,
  }
}

export async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Issue Final Invoice", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    const result = await run(req.body || {})
    return res.json(result)
  } catch (e) {
    console.error("[issue_final_invoice]", e)
    return res.status(500).json({ error: e.message })
  }
}