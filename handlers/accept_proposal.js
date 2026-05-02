// ─── accept_proposal.js ────────────────────────────────────────────────────
// POST /api/accept_proposal   { "page_id": "<proposal_page_id>" }
// Triggered by "Mark as Accepted" Notion button on a Proposal page.
//
// Standard flow (proposal always comes after discovery call):
//   Lead → Discovery Call → Convert to Deal → Create Proposal (from Deal)
//   → Client accepts → accept_proposal fires → Quotation (Approved) created
//   → Notion automation (Quotation Approved) → create_invoice → Invoice + Project
//
// Steps:
//   1. Read Proposal data (Deal already linked via standard flow)
//   2. [Fallback only] If no Deal linked → create Deal from Lead
//   3. Create Quotation with Status → Approved
//   4. Populate Quotation line items (Base OS + main OS + add-ons)
//   5. Stitch all relations (Quotation ↔ Deal, Lead, Company, Proposal)
//   6. Mark Proposal → Accepted
//   7. Notion automation watches Quotation "Approved" → fires create_invoice
//      → Invoice + Project created automatically

import { waitUntil } from "@vercel/functions"
import { getPage, patchPage, createPage, queryDB, plain, DB } from "../lib/notion.js"

function hdrs() {
  return {
    Authorization:    `Bearer ${process.env.NOTION_API_KEY}`,
    "Notion-Version": "2022-06-28",
    "Content-Type":   "application/json",
  }
}

// ── OS slug maps ──────────────────────────────────────────────────────────
const OS_SLUG_MAP = {
  "revenue os":      "revenue-os",
  "operations os":   "operations-os",
  "business os":     "business-os",
  "marketing os":    "marketing-os",
  "finance os":      "finance-os",
  "team os":         "team-os",
  "retention os":    "retention-os",
  "agency os":       "full-platform-os",
  "intelligence os": "intelligence-os",
}

const ADDON_SLUG_MAP = {
  "additional system module":          "addon-system-module",
  "automation — within database":      "addon-automation-within",
  "automation (within database)":      "addon-automation-within",
  "automation — cross-database":       "addon-automation-cross",
  "automation (cross-database)":       "addon-automation-cross",
  "enhanced dashboard":                "addon-dashboard",
  "advanced dashboard":                "addon-dashboard",
  "custom widget":                     "addon-widget",
  "api / external integration":        "addon-api-integration",
  "automation & workflow integration": "addon-workflow-integration",
  "lead capture system":               "addon-lead-capture",
  "client portal view":                "addon-client-portal",
  "ai agent integration":              "addon-ai-agent",
  "ads platform integration":          "addon-ads-integration",
  "project kickoff automation":        "automation-project-kickoff",
  "campaign kickoff automation":       "automation-campaign-kickoff",
  "client onboarding kickoff":         "automation-onboarding-kickoff",
  "renewal kickoff automation":        "automation-renewal-kickoff",
  "document generation":               "addon-doc-generation",
}

const OS_NAMES = new Set([
  "Revenue OS","Operations OS","Business OS","Marketing OS",
  "Finance OS","Team OS","Retention OS","Agency OS","Intelligence OS",
])

const OS_PACKAGE_SLUGS = new Set([
  "revenue-os","operations-os","business-os","full-platform-os",
  "marketing-os","finance-os","team-os","retention-os","intelligence-os",
  "micro-install-1","micro-install-2","micro-install-3",
])

// ── Module descriptions ────────────────────────────────────────────────────
const OS_MODULES = {
  "revenue-os": {
    "Revenue OS": ["CRM & Pipeline","Billing & Payment Tracker","Retainer Management",
                   "Product & Pricing Catalogue","Meetings & Calls Log"],
  },
  "operations-os": {
    "Operations OS": ["Project & Task Management","Client Delivery Tracker","Approval & QC Tracker",
                      "Internal Meeting & Action Log","Resource & Capacity Planner"],
  },
  "marketing-os": {
    "Marketing OS": ["Content Production Tracker","Campaign Tracker","Lead Generation Tracker",
                     "Marketing Performance Tracker","Brand & Asset Library"],
  },
  "finance-os": {
    "Finance OS": ["Finance Ledger","Cash Flow Tracker","Invoice & Payment Tracker",
                   "Payroll & Staff Costs","Profit & Loss Tracker"],
  },
  "business-os": {
    "Revenue OS":    ["CRM & Pipeline","Billing & Payment Tracker","Retainer Management",
                      "Product & Pricing Catalogue","Meetings & Calls Log"],
    "Operations OS": ["Project & Task Management","Client Delivery Tracker","Approval & QC Tracker",
                      "Internal Meeting & Action Log","Resource & Capacity Planner"],
  },
  "full-platform-os": {
    "Revenue OS":    ["CRM & Pipeline","Billing & Payment Tracker","Retainer Management",
                      "Product & Pricing Catalogue","Meetings & Calls Log"],
    "Operations OS": ["Project & Task Management","Client Delivery Tracker","Approval & QC Tracker",
                      "Internal Meeting & Action Log","Resource & Capacity Planner"],
    "Marketing OS":  ["Content Production Tracker","Campaign Tracker","Lead Generation Tracker",
                      "Marketing Performance Tracker","Brand & Asset Library"],
  },
  "team-os": {
    "Team OS": ["Hiring Pipeline","Team Onboarding Tracker","Performance & Goals",
                "Leave & Availability","Role & Compensation Log"],
  },
  "retention-os": {
    "Retention OS": ["Client Health Tracker","Client Communication Log","Renewal Pipeline",
                     "Upsell Opportunity Tracker","Retainer Health Tracker"],
  },
}

function buildModuleDescription(slug) {
  const groups = OS_MODULES[slug]
  if (!groups) return ""
  return Object.entries(groups)
    .map(([grp, mods]) => `${grp}: ${mods.join(" · ")}`)
    .join("\n")
}

// ── Fetch product from Catalogue by slug ──────────────────────────────────
async function fetchProduct(slug) {
  if (!slug) return null
  try {
    const rows = await queryDB(DB.CATALOGUE, {
      property: "Slug", rich_text: { equals: slug }
    }, process.env.NOTION_API_KEY)
    if (!rows.length) return null
    const p = rows[0]
    const props = p.properties
    return {
      id:          p.id.replace(/-/g, ""),
      name:        plain(props["Product Name"]?.title || []),
      price:       props["Price (MYR)"]?.number ?? props["Price"]?.number ?? null,
      description: plain(props.Description?.rich_text || []),
      slug,
    }
  } catch (e) {
    console.warn("[accept_proposal] fetchProduct:", slug, e.message)
    return null
  }
}

// ── Create Quotation page (status: Approved — triggers Notion automation) ─
async function createQuotation({ companyId, dealId, leadId, picId, payTerms, quoteType, packages, proposalId }) {
  const today = new Date().toISOString().split("T")[0]
  const validUntilD = new Date(); validUntilD.setDate(validUntilD.getDate() + 30)
  const validUntil  = validUntilD.toISOString().split("T")[0]

  const props = {
    "Quotation No.": { title: [{ text: { content: "" } }] },
    "Status":        { status: { name: "Approved" } },   // ← triggers create_invoice automation
    "Issue Date":    { date: { start: today } },
    "Valid Until":   { date: { start: validUntil } },
    "Payment Terms": { select: { name: payTerms || "50% Deposit" } },
    ...(quoteType         ? { "Quote Type":  { select: { name: quoteType } } } : {}),
    ...(companyId         ? { "Company":     { relation: [{ id: companyId }] } } : {}),
    ...(dealId            ? { "Deal Source": { relation: [{ id: dealId }] } } : {}),
    ...(leadId            ? { "Lead Source": { relation: [{ id: leadId }] } } : {}),
    ...(picId             ? { "Primary Contact": { relation: [{ id: picId }] } } : {}),
  }

  const page = await createPage({
    parent:     { database_id: DB.QUOTATIONS },
    properties: props,
  }, process.env.NOTION_API_KEY)

  return page.id.replace(/-/g, "")
}

// ── Create Deal from Lead data ─────────────────────────────────────────────
async function createDealFromLead(leadId, leadProps, companyId, companyName, osTypeName) {
  const dealName = companyName
    ? `${companyName} — ${osTypeName || "OS"}`
    : osTypeName || "New Deal"

  const dealProps = {
    "Deal Name":  { title: [{ text: { content: dealName } }] },
    "Stage":      { select: { name: "Discovery Done" } },
    ...(companyId ? { "Company":      { relation: [{ id: companyId }] } } : {}),
    ...(leadId    ? { "Origin Lead":  { relation: [{ id: leadId }] } } : {}),
  }

  // Copy relevant fields from lead
  const situation = plain(leadProps.Situation?.rich_text || [])
  if (situation) dealProps["Situation"] = { rich_text: [{ text: { content: situation.slice(0, 2000) } }] }

  const osInterest = leadProps["OS Interest"]?.multi_select?.map(s => s.name) || []
  if (osInterest.length) dealProps["Packages"] = { multi_select: osInterest.map(n => ({ name: n })) }

  const potValue = leadProps["Potential Value"]?.formula?.number ?? leadProps["Potential Value"]?.number
  if (potValue) dealProps["Deal Value"] = { number: potValue }

  const page = await createPage({
    parent:     { database_id: DB.DEALS },
    properties: dealProps,
  }, process.env.NOTION_API_KEY)

  return page.id.replace(/-/g, "")
}

// ── Create inline Products & Services DB on quotation ─────────────────────
async function createLineItemsDB(pageId) {
  const r = await fetch("https://api.notion.com/v1/databases", {
    method: "POST", headers: hdrs(),
    body: JSON.stringify({
      parent:    { type: "page_id", page_id: pageId },
      is_inline: true,
      title:     [{ type: "text", text: { content: "Products & Services" } }],
      properties: {
        "Notes":       { title: {} },
        "Product":     { relation: { database_id: DB.CATALOGUE, single_property: {} } },
        "Description": { rich_text: {} },
        "Unit Price":  { number: { format: "ringgit" } },
        "Qty":         { number: { format: "number" } },
        "Subtotal":    { formula: { expression: 'prop("Qty") * prop("Unit Price")' } },
      },
    }),
  })
  if (!r.ok) throw new Error(`Create inline DB: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return (await r.json()).id.replace(/-/g, "")
}

async function createLineItem(dbId, product) {
  const baseProps = {
    "Notes": { title: [] },
    "Qty":   { number: 1 },
    ...(product.id             ? { "Product":    { relation: [{ id: product.id }] } } : {}),
    ...(product.price != null  ? { "Unit Price": { number: Number(product.price) } } : {}),
    ...(product.description    ? { "Description": { rich_text: [{ text: { content: product.description.slice(0, 2000) } }] } } : {}),
  }
  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST", headers: hdrs(),
    body:   JSON.stringify({ parent: { database_id: dbId }, properties: baseProps }),
  })
  if (!r.ok) console.warn(`[accept_proposal] line item failed: ${r.status}`)
  return r.ok ? await r.json() : null
}

// ── Append relation (safe upsert) ─────────────────────────────────────────
async function appendRelation(pageId, propName, targetId) {
  try {
    const page = await getPage(pageId, process.env.NOTION_API_KEY)
    const existing = (page.properties[propName]?.relation || []).map(r => ({ id: r.id }))
    const already  = existing.some(r => r.id.replace(/-/g, "") === targetId)
    if (already) return
    await patchPage(pageId, {
      [propName]: { relation: [...existing, { id: targetId }] }
    }, process.env.NOTION_API_KEY)
  } catch (e) {
    console.warn(`[accept_proposal] appendRelation ${propName}:`, e.message)
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────
export async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Accept Proposal", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const body = req.body || {}
  const proposalId = (
    body.page_id      ||
    body.data?.id     ||
    body.proposal_id  ||
    ""
  ).replace(/-/g, "")

  if (!proposalId) return res.status(400).json({ error: "Missing proposal page_id" })

  // Respond immediately so Notion button doesn't time out
  res.status(200).json({ status: "accepted", proposal_id: proposalId })

  waitUntil((async () => { try {
    // ── 1. Read Proposal ──────────────────────────────────────────────────
    const proposal = (body.data?.object === "page" && body.data?.properties)
      ? body.data
      : await getPage(proposalId, process.env.NOTION_API_KEY)
    const pp = proposal.properties

    const packageNamesMulti = (pp["Packages"]?.multi_select || []).map(s => s.name)

    // Resolve OS from "OS Packages" relation (primary — set by create_proposal.js)
    let resolvedPackageNames = []
    let resolvedPackageIds   = []
    const osPackageRels = (pp["OS Packages"]?.relation || []).map(r => r.id.replace(/-/g, ""))
    if (osPackageRels.length) {
      const osPgs = await Promise.all(osPackageRels.map(id => getPage(id, process.env.NOTION_API_KEY).catch(() => null)))
      for (const pg of osPgs.filter(Boolean)) {
        const name = plain(pg.properties["Product Name"]?.title || [])
        if (name) { resolvedPackageNames.push(name); resolvedPackageIds.push(pg.id.replace(/-/g, "")) }
      }
    }

    // Also read add-on relation (Add-Ons on proposal)
    const addonRels = (pp["Add-Ons"]?.relation || pp["Add-ons"]?.relation || []).map(r => r.id.replace(/-/g, ""))
    let resolvedAddonNames = []
    let resolvedAddonIds   = []
    if (addonRels.length) {
      const addonPgs = await Promise.all(addonRels.map(id => getPage(id, process.env.NOTION_API_KEY).catch(() => null)))
      for (const pg of addonPgs.filter(Boolean)) {
        const name = plain(pg.properties["Product Name"]?.title || [])
        const price = pg.properties["Price (MYR)"]?.number ?? null
        if (name) { resolvedAddonNames.push(name); resolvedAddonIds.push({ id: pg.id.replace(/-/g, ""), name, price, description: plain(pg.properties["Description"]?.rich_text || []) }) }
      }
    }

    const packageNames = resolvedPackageNames.length ? resolvedPackageNames : packageNamesMulti
    const osTypeName   = pp["OS Type"]?.select?.name || packageNames.find(n => OS_NAMES.has(n)) || resolvedPackageNames[0] || ""
    const osSlug       = OS_SLUG_MAP[osTypeName.toLowerCase().trim()] || null
    const payTerms     = pp["Payment Terms"]?.select?.name || "50% Deposit"
    const proposalQT   = pp["Quote Type"]?.select?.name   || "New Business"
    const quoteTypeMap = { "New Business":"New Business","Renewal":"Renewal","Add-On":"Expansion","Retainer":"Service/Maintenance" }
    const quoteType    = quoteTypeMap[proposalQT] || "New Business"

    const companyId = pp.Company?.relation?.[0]?.id?.replace(/-/g, "") || null
    let   leadId    = pp["Lead Source"]?.relation?.[0]?.id?.replace(/-/g, "") || null
    let   dealId    = pp["Deal Source"]?.relation?.[0]?.id?.replace(/-/g, "") || null
    const picId     = (pp["Primary Contact"]?.relation || pp.PIC?.relation || [])[0]?.id?.replace(/-/g, "") || null

    console.log("[accept_proposal] proposal:", proposalId, "| os:", osTypeName, "| deal:", dealId, "| lead:", leadId)

    // ── 2. Resolve company name ───────────────────────────────────────────
    let companyName = ""
    if (companyId) {
      try {
        const cp = await getPage(companyId, process.env.NOTION_API_KEY)
        for (const v of Object.values(cp.properties)) {
          if (v.type === "title") { companyName = plain(v.title); break }
        }
      } catch (e) { console.warn("[accept_proposal] company fetch:", e.message) }
    }

    // ── 3. Create Deal if not already linked ─────────────────────────────
    if (!dealId) {
      console.log("[accept_proposal] no deal found — creating from lead")
      let leadProps = {}
      if (leadId) {
        try {
          const lp = await getPage(leadId, process.env.NOTION_API_KEY)
          leadProps = lp.properties
        } catch (e) { console.warn("[accept_proposal] lead fetch:", e.message) }
      }
      dealId = await createDealFromLead(leadId, leadProps, companyId, companyName, osTypeName)
      console.log("[accept_proposal] deal created:", dealId)

      // Stitch Lead → Deal
      if (leadId) await appendRelation(leadId, "Deal", dealId)
      // Mark Lead stage → Discovery Done
      if (leadId) {
        await patchPage(leadId, { "Stage": { status: { name: "Discovery Done" } } }, process.env.NOTION_API_KEY).catch(() => {})
      }
      // Link Proposal → Deal
      await patchPage(proposalId, { "Deal Source": { relation: [{ id: dealId }] } }, process.env.NOTION_API_KEY).catch(() => {})
    }

    // ── 4. Create Quotation (Status: Approved → triggers create_invoice) ─
    const addonPackageNames = packageNames.filter(n => !OS_NAMES.has(n))
    const quotId = await createQuotation({
      companyId, dealId, leadId, picId, payTerms, quoteType,
      packages: packageNames, proposalId,
    })
    console.log("[accept_proposal] quotation created:", quotId)

    // Allow Notion to index the new page before we write children
    await new Promise(r => setTimeout(r, 1500))

    // ── 5. Populate Quotation line items ──────────────────────────────────
    const isOsPkg = osSlug && OS_PACKAGE_SLUGS.has(osSlug)

    // Use directly-resolved addon products (from relation) when available
    // Fall back to slug lookup from package name multi_select
    const addonPackageNamesFallback = packageNames.filter(n => !OS_NAMES.has(n))
    const [baseProduct, mainProduct, ...slugAddonProducts] = await Promise.all([
      isOsPkg ? fetchProduct("base-os") : Promise.resolve(null),
      osSlug  ? fetchProduct(osSlug)    : Promise.resolve(null),
      ...addonPackageNamesFallback.map(n => {
        const slug = ADDON_SLUG_MAP[n.toLowerCase().trim()]
        return slug ? fetchProduct(slug) : Promise.resolve(null)
      }),
    ])

    // Direct addon products from relation take priority; slug-fetched as fallback
    const addonProducts = resolvedAddonIds.length ? resolvedAddonIds : slugAddonProducts.filter(Boolean)

    const lineItems = []
    if (isOsPkg && baseProduct?.id) lineItems.push(baseProduct)
    if (mainProduct?.id) {
      lineItems.push({
        ...mainProduct,
        description: buildModuleDescription(osSlug) || mainProduct.description,
      })
    }
    lineItems.push(...addonProducts.filter(Boolean))

    const dbId = await createLineItemsDB(quotId)
    await new Promise(r => setTimeout(r, 800))

    for (const item of lineItems) await createLineItem(dbId, item)
    console.log("[accept_proposal] wrote", lineItems.length, "line items")

    // Patch Amount onto quotation so create_invoice and Deposit Due formula have the value
    const totalAmount = lineItems.reduce((sum, p) => sum + (p?.price ?? 0), 0)
    if (totalAmount > 0) {
      await patchPage(quotId, { "Amount": { number: totalAmount } }, process.env.NOTION_API_KEY).catch(e =>
        console.warn("[accept_proposal] amount patch:", e.message)
      )
      console.log("[accept_proposal] Amount:", totalAmount)
    }

    // ── 6. Stitch relations ───────────────────────────────────────────────
    // Deal → Quotation
    await appendRelation(dealId, "Quotations", quotId)
    // Proposal → Converted Quotation
    await appendRelation(proposalId, "Converted Quotation", quotId)

    // ── 7. Mark Proposal → Accepted ──────────────────────────────────────
    await patchPage(proposalId, {
      "Status": { status: { name: "Accepted" } },
    }, process.env.NOTION_API_KEY)

    // ── 8. Advance Lead stage → Converted ────────────────────────────────
    if (leadId) {
      try {
        await patchPage(leadId, { "Stage": { status: { name: "Converted" } } }, process.env.NOTION_API_KEY)
        console.log("[accept_proposal] lead → Converted")
      } catch (e) {
        console.warn("[accept_proposal] lead stage update:", e.message)
      }
    }

    // ── 9. Auto-create Team Task — proposal accepted / awaiting deposit ───
    // (Notion automation fires create_invoice → Invoice + Project created)
    // The deposit_paid flow will create the build task — no task needed here.

    console.log("[accept_proposal] done — Notion automation will create Invoice + Project")

    console.log("[accept_proposal] done", { proposalId, dealId, quotId, osTypeName, lineItems: lineItems.length })

  } catch (e) {
    console.error("[accept_proposal] error:", e.message, e.stack?.slice(0, 400))
  } })())
}