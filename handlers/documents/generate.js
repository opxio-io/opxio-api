// ─── generate.js ───────────────────────────────────────────────────────────
// waitUntil stub — on Express, just fire and forget
const waitUntil = (p) => Promise.resolve(p).catch(console.error)
// GET /api/generate?page_id=<id>&type=quotation|invoice|receipt
// Triggered by Notion button "Generate PDF".
//
// Responds 200 immediately, then runs PDF generation in the background via
// waitUntil() — Vercel's official API for post-response work in Node.js
// serverless functions.

import {
  fetchQuotationData, fetchInvoiceData, fetchProposalData,
  generateQuotationPdf, generateInvoicePdf, generateReceiptPdf
} from "../../lib/pdf.js"
import { OS_DEFAULT_MODULES, OS_DEFAULT_ADDONS_LATER, renderProposal } from "../../lib/proposal_template.js"
import { htmlToPdf } from "../../lib/puppeteer.js"
import { uploadBlob } from "../../lib/blob.js"
import { patchPage, getPage, queryDB, plain, fetchCompanyDetails, DB } from "../../lib/notion.js"

export const config = {
  api: { responseLimit: false },
}

function detectType(req) {
  const t = (req.query.type || req.body?.type || "quotation").toLowerCase()
  return t
}

// ── Sequential proposal number generator: PRO-2026-001 ───────────────────
async function generateProposalNo() {
  try {
    const rows = await queryDB(DB.PROPOSALS, null, process.env.NOTION_API_KEY)
    const year = new Date().getFullYear()
    let maxNum = 0
    for (const row of rows) {
      for (const [, v] of Object.entries(row.properties)) {
        if (v.type === "title") {
          const t = plain(v.title)
          const m = t.match(/PRO-\d{4}-(\d+)/i)
          if (m) { const n = parseInt(m[1]); if (n > maxNum) maxNum = n }
        }
      }
    }
    return `PRO-${year}-${String(maxNum + 1).padStart(3, "0")}`
  } catch (e) {
    console.warn("[generateProposalNo]", e.message)
    return `PRO-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`
  }
}

async function handleQuotation(pageId) {
  const data     = await fetchQuotationData(pageId, process.env.NOTION_API_KEY)
  const pdfBuf   = await generateQuotationPdf(data)
  const filename = `quotations/${data.quotation_no || pageId}.pdf`
  const { url }  = await uploadBlob(filename, pdfBuf)

  const total  = (data.line_items || []).reduce((s, i) => s + (i.qty || 1) * (i.unit_price || 0), 0)
  // Append timestamp so Notion always opens a fresh PDF (Vercel Blob caches 1 year by default)
  const pdfUrl = `${url}?v=${Date.now()}`

  await patchPage(pageId, {
    "PDF":        { url: pdfUrl },
    "Status":     { status: { name: "Draft" } },
    "Issue Date": { date: { start: new Date().toISOString().split("T")[0] } },
    ...(total > 0 ? { "Amount": { number: total } } : {}),
    ...(data.currency ? { "Currency": { select: { name: data.currency } } } : {}),
    ...(data.quotation_no && data.title_prop_name
      ? { [data.title_prop_name]: { title: [{ text: { content: data.quotation_no } }] } }
      : {}),
  }, process.env.NOTION_API_KEY)

  console.log(`[generate:quotation] done — ${data.quotation_no} — ${pdfUrl}`)
  return { type: "quotation", quotation_no: data.quotation_no, pdf_url: pdfUrl, total }
}

async function handleProposal(pageId) {
  const data = await fetchProposalData(pageId, process.env.NOTION_API_KEY)

  // ── Generate sequential ref number if page title isn't a valid PRO ref ──
  // Treat "New Proposal", empty, timestamp fallbacks, or anything that isn't
  // PRO-YYYY-NNN as blank so we always write a clean sequential number.
  const titleIsBlank = !data.proposal_no || !/^PRO-\d{4}-\d{3,}$/i.test(data.proposal_no.trim())
  const proposalNo   = titleIsBlank ? await generateProposalNo() : data.proposal_no

  // ── Map fetched data → renderProposal format ────────────────────────────
  const osType     = data.os_type || ""
  const osPackages = data.os_packages && data.os_packages.length ? data.os_packages : (osType ? [osType] : [])

  // ── Build modules from each installed OS package individually ─────────
  // Merge per-package module lists so Revenue OS + Operations OS = both sections
  let modules = {}
  for (const pkg of osPackages) {
    Object.assign(modules, OS_DEFAULT_MODULES[pkg] || {})
  }
  if (!Object.keys(modules).length) modules = OS_DEFAULT_MODULES[osType] || {}

  // ── Add-ons later: union across all installed OS packages ─────────────
  const addonsLaterSet = new Set()
  for (const pkg of osPackages) {
    for (const a of (OS_DEFAULT_ADDONS_LATER[pkg] || [])) addonsLaterSet.add(a)
  }
  const addonsLater = addonsLaterSet.size ? [...addonsLaterSet] : (OS_DEFAULT_ADDONS_LATER[osType] || [])

  // ── Derive install tier from bundle size (internal naming) ────────────
  const BUNDLE_NAMES = { 1: "Starter", 2: "Dual", 3: "Pro", 4: "Full Stack" }
  const installTier  = BUNDLE_NAMES[osPackages.length] || "Standard"

  // ── Derive Notion plan: Business if Team OS or Enhanced Dashboard, else Plus
  const needsBusiness = osPackages.some(p => /team\s+os/i.test(p))
  const notionPlan    = needsBusiness ? "Business" : "Plus"

  // ── Split line items: core (Base OS + OS packages) vs add-ons ─────────
  const isCoreItem = name => /base\s*os/i.test(name) || /\b(revenue|operations|business|finance|marketing|agency|team|retention|sales|intelligence|starter)\s+os\b/i.test(name)
  const coreItems  = (data.line_items || []).filter(i => isCoreItem(i.name || ''))
  const addonItems = (data.line_items || []).filter(i => !isCoreItem(i.name || ''))

  // Derive fee from core OS line items; fall back to all items if none tagged
  const feeBase = coreItems.length
    ? coreItems.reduce((s, i) => s + (i.qty || 1) * (i.unit_price || 0), 0)
    : (data.line_items || []).reduce((s, i) => s + (i.qty || 1) * (i.unit_price || 0), 0)
  const fee = feeBase || data.fee || 0

  // Map add-on line items to the proposal template format
  const addonNowItems = addonItems.map(i => ({
    name:        i.name || '',
    desc:        i.desc || '',
    price_label: i.unit_price ? `RM ${Number(i.unit_price).toLocaleString('en-MY')}` : '',
    cadence:     'one-time',
  }))

  // Format dates for display
  function fmtDate(iso) {
    if (!iso) return ""
    const d = new Date(iso)
    return d.toLocaleDateString("en-MY", { day: "numeric", month: "long", year: "numeric" })
  }

  const templateData = {
    ref_number:    proposalNo,
    date:          fmtDate(data.issue_date) || new Date().toLocaleDateString("en-MY", { month: "long", year: "numeric" }),
    valid_until:   fmtDate(data.valid_until),
    company_name:  data.company_name || "Client",
    contact_name:  data.pic_name     || "",
    contact_role:  data.pic_role     || "",
    whatsapp:      data.pic_phone    || "",
    email:         "hello@opxio.io",
    website:       "opxio.io",
    os_type:       osType,
    install_tier:  installTier,
    notion_plan:   notionPlan,
    timeline:      "3–4 weeks",
    fee,
    retainer:      "maintenance",
    // Build situation blocks with labels from the three context fields on the Proposal page
    situation: [
      data.situation       ? { label: "Situation",       text: data.situation }       : null,
      data.problems_solved ? { label: "Problems Solved", text: data.problems_solved } : null,
      data.goals           ? { label: "Goals",           text: data.goals }           : null,
    ].filter(Boolean),
    modules,
    addons_now:    addonNowItems,
    addons_later:  addonsLater,
    line_items:    data.line_items || [],
  }

  const html    = renderProposal(templateData)
  const pdfBuf  = await htmlToPdf(html)

  const filename = `proposals/${proposalNo || pageId}.pdf`
  const { url }  = await uploadBlob(filename, pdfBuf)
  const pdfUrl   = `${url}?v=${Date.now()}`

  await patchPage(pageId, {
    "PDF":    { url: pdfUrl },
    "Status": { status: { name: "Ready to Send" } },
    "Date":   { date: { start: new Date().toISOString().split("T")[0] } },
    // Write the ref number back to the title field
    ...(proposalNo && data.title_prop_name
      ? { [data.title_prop_name]: { title: [{ text: { content: proposalNo } }] } }
      : {}),
  }, process.env.NOTION_API_KEY)

  console.log(`[generate:proposal] done — ${proposalNo} — ${pdfUrl}`)
  return { type: "proposal", proposal_no: proposalNo, pdf_url: pdfUrl }
}

async function handleInvoice(pageId) {
  const data   = await fetchInvoiceData(pageId, process.env.NOTION_API_KEY)
  const pdfBuf = await generateInvoicePdf(data)
  // Note: invoice_no already contains the type suffix (e.g. -D, -F) from formatInvoiceNumber
  const filename = `invoices/${data.invoice_no || pageId}.pdf`
  const { url }  = await uploadBlob(filename, pdfBuf)
  // Append timestamp so Notion always opens a fresh PDF (Vercel Blob caches 1 year by default)
  const pdfUrl = `${url}?v=${Date.now()}`

  // Write PDF URL first — critical path. Separate from Invoice No. so one can't block the other.
  // Invoice DB field is "Invoice PDF" (URL property), NOT "PDF"
  await patchPage(pageId, {
    "Invoice PDF": { url: pdfUrl },
  }, process.env.NOTION_API_KEY)

  // Write Invoice No. back (fetchInvoiceData already assigned it, this confirms it)
  if (data.invoice_no) {
    patchPage(pageId, {
      "Invoice No.": { title: [{ text: { content: data.invoice_no } }] },
    }, process.env.NOTION_API_KEY).catch(e =>
      console.warn("[generate:invoice] invoice_no patch:", e.message)
    )
  }

  console.log(`[generate:invoice] done — ${data.invoice_no} — ${pdfUrl}`)
  return { type: "invoice", invoice_no: data.invoice_no, invoice_type: data.invoice_type, pdf_url: pdfUrl }
}

async function handleReceipt(pageId) {
  const page  = await getPage(pageId, process.env.NOTION_API_KEY)
  const props = page.properties

  const receiptNo  = plain(props["Receipt No."]?.title || [])
  const issueDate  = props["Issue Date"]?.date?.start || new Date().toISOString().split("T")[0]
  const amtPaid    = props["Amount Paid"]?.number || props["Total Amount"]?.number || 0
  const payMethod  = props["Payment Method"]?.select?.name || "Bank Transfer"

  let companyName = ""
  const compRels  = props.Company?.relation || []
  if (compRels.length) {
    try {
      const cp = await getPage(compRels[0].id.replace(/-/g, ""), process.env.NOTION_API_KEY)
      const cprops = cp.properties
      for (const [, v] of Object.entries(cprops)) {
        if (v.type === "title") { companyName = plain(v.title); break }
      }
    } catch {}
  }

  let invoiceNo = ""
  const invRels = props.Invoice?.relation || []
  if (invRels.length) {
    try {
      const ip = await getPage(invRels[0].id.replace(/-/g, ""), process.env.NOTION_API_KEY)
      invoiceNo = plain(ip.properties["Invoice No."]?.title || [])
    } catch {}
  }

  const ourCompany = await fetchCompanyDetails(process.env.NOTION_API_KEY)

  const data = {
    receipt_no:      receiptNo || `RCP-${Date.now()}`,
    issue_date:      issueDate,
    invoice_no:      invoiceNo,
    company_name:    companyName,
    company_address: "",
    company_phone:   "",
    amount_paid:     amtPaid,
    payment_method:  payMethod,
    our_company:     ourCompany,
  }

  const pdfBuf   = await generateReceiptPdf(data)
  const filename = `receipts/${data.receipt_no}.pdf`
  const { url }  = await uploadBlob(filename, pdfBuf)

  await patchPage(pageId, { "PDF": { url } }, process.env.NOTION_API_KEY)

  console.log(`[generate:receipt] done — ${data.receipt_no} — ${url}`)
  return { type: "receipt", receipt_no: data.receipt_no, pdf_url: url }
}

export function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" })
  }

  // Log full request so we can see exactly what Notion sends
  console.log("[generate] method:", req.method)
  console.log("[generate] query:", JSON.stringify(req.query))
  console.log("[generate] body:", JSON.stringify(req.body))

  // Notion webhooks send page ID in various body shapes
  const rawId =
    req.body?.data?.id      ||
    req.body?.entity?.id    ||
    req.body?.pageId        ||
    req.body?.page_id       ||
    req.body?.data?.page_id ||
    req.body?.id            ||
    req.query.page_id       ||
    req.query.id

  if (!rawId || String(rawId).includes("{{")) {
    console.log("[generate] rejected — rawId:", rawId)
    return res.status(400).json({
      error: "Missing or invalid page_id",
      received_body: req.body,
      received_query: req.query,
    })
  }

  const pageId = rawId.replace(/-/g, "")
  const type   = detectType(req)

  // ── Respond immediately so Notion's button doesn't time out ──────────────
  res.status(200).json({ status: "accepted", type, page_id: pageId })

  // ── waitUntil: Vercel keeps the function alive until this Promise settles ─
  // This is the ONLY reliable way to do post-response work in Vercel serverless.
  const work = (async () => {
    try {
      if (type === "invoice") {
        await handleInvoice(pageId)
      } else if (type === "receipt") {
        await handleReceipt(pageId)
      } else if (type === "proposal") {
        await handleProposal(pageId)
      } else {
        await handleQuotation(pageId)
      }
    } catch (e) {
      console.error(`[generate:${type}] error:`, e.message, e.stack)
    }
  })()

  waitUntil(work)
}