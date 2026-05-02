// ─── create_proposal.js ────────────────────────────────────────────────────
// POST /api/create_proposal  { "page_id": "<lead_page_id>" }
// Triggered by Notion button on a Lead CRM page (two-action button):
//   Action 1: "Add a page to Proposals DB" (applies template with inline P&S DB)
//   Action 2: "Send webhook" to this endpoint with Lead page_id
//
// What this does:
//   1. Reads lead info (Company, PIC, OS Type, Add-Ons)
//   2. Finds the recently created Proposal page (within last 3min)
//   3. Patches Proposal with lead data (OS Type, Company, PIC, Payment Terms)
//   4. Creates or finds the inline Products & Services DB on the Proposal page
//   5. Auto-populates line items (Base OS → Main OS → Add-Ons, sequential)
//   6. Advances Lead stage → "Proposal Sent"

import { getPage, patchPage, createPage, queryDB, plain, DB } from "../../lib/notion"

function hdrs() {
  return {
    Authorization:    `Bearer ${process.env.NOTION_API_KEY}`,
    "Notion-Version": "2022-06-28",
    "Content-Type":   "application/json",
  }
}

// ── Package slug → Catalogue DB ───────────────────────────────────────────
const OS_TYPE_SLUG_MAP = {
  "revenue os":      "revenue-os",
  "sales os":        "revenue-os",
  "operations os":   "operations-os",
  "business os":     "business-os",
  "marketing os":    "marketing-os",
  "agency os":       "full-platform-os",
  "full platform":   "full-platform-os",
  "team os":         "team-os",
  "retention os":    "retention-os",
  "intelligence os": "intelligence-os",
  "starter os":      "starter-os",
}

const ADDON_SLUG_MAP = {
  "additional system module":           "addon-system-module",
  "automation (within database)":       "addon-automation-within",
  "automation — within database":       "addon-automation-within",
  "automation (cross-database)":        "addon-automation-cross",
  "automation — cross-database":        "addon-automation-cross",
  "advanced dashboard":                 "addon-dashboard",
  "enhanced dashboard":                 "addon-dashboard",
  "custom widget":                      "addon-widget",
  "api / external integration":         "addon-api-integration",
  "automation & workflow integration":  "addon-workflow-integration",
  "lead capture system":                "addon-lead-capture",
  "client portal view":                 "addon-client-portal",
  "ai agent integration":               "addon-ai-agent",
}

const OS_PACKAGE_SLUGS = new Set([
  "revenue-os", "operations-os", "business-os", "full-platform-os",
  "marketing-os", "team-os", "retention-os", "intelligence-os",
  "starter-os",
])

// ── Country → currency (mirrors qualify.js) ────────────────────────────────
const COUNTRY_CURRENCY = {
  Malaysia: "MYR", Singapore: "SGD", Indonesia: "IDR", Philippines: "PHP",
  Thailand: "THB", Vietnam: "VND", Bangladesh: "BDT", India: "INR",
  UK: "GBP", Australia: "AUD", USA: "USD",
}

// ── Fetch product info from Catalogue ──────────────────────────────────────
// currency: "MYR" → use Price field; anything else → use Price (USD)
async function fetchProductInfo(slug, currency = "MYR") {
  if (!slug) return null
  try {
    const rows = await queryDB(DB.CATALOGUE, {
      property: "Slug", rich_text: { equals: slug }
    }, process.env.NOTION_API_KEY)
    if (!rows.length) return null
    const p = rows[0]
    const priceField = currency === "MYR" ? "Price (MYR)" : "Price (USD)"
    return {
      id:          p.id.replace(/-/g, ""),
      name:        plain(p.properties["Product Name"]?.title || []),
      price:       p.properties[priceField]?.number ?? null,
      quote_type:  p.properties["Quote Type"]?.select?.name || "New Business",
      description: plain(p.properties.Description?.rich_text || []),
      slug,
    }
  } catch (e) {
    console.warn("[create_proposal] fetchProductInfo:", slug, e.message)
    return null
  }
}

// ── Find the most recently created proposal (within last 3 min) ────────────
// ── Find proposal via Lead's Proposals relation (primary) ─────────────────
// Notion button Action 1 creates proposal page with Deal Source = Lead,
// which auto-populates Lead.Proposals (bidirectional). We read that to find
// the newly created proposal — same pattern as create_quotation.js
async function findProposalFromLead(leadProps, maxAgeSeconds = 180) {
  const proposalIds = (leadProps.Proposals?.relation || []).map(r => r.id.replace(/-/g, ""))
  if (!proposalIds.length) return null

  const pages = await Promise.all(proposalIds.map(async id => {
    try {
      const p   = await getPage(id, process.env.NOTION_API_KEY)
      const age = (Date.now() - new Date(p.created_time)) / 1000
      return age <= maxAgeSeconds ? { id, page: p, age } : null
    } catch { return null }
  }))

  const recent = pages.filter(Boolean).sort((a, b) => a.age - b.age)[0]
  if (recent) {
    console.log(`[findProposalFromLead] found: ${recent.id.slice(0,8)} age:${recent.age.toFixed(0)}s`)
    return { id: recent.id }
  }
  return null
}

// ── Fallback: find most recently created proposal page (time-based) ────────
async function findRecentProposal(maxAgeSeconds = 180) {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${DB.PROPOSALS}/query`, {
      method: "POST", headers: hdrs(),
      body: JSON.stringify({
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 5,
      }),
    })
    const data = await r.json()
    const now  = Date.now()
    for (const row of data.results || []) {
      const age = (now - new Date(row.created_time)) / 1000
      if (age <= maxAgeSeconds) {
        const id = row.id.replace(/-/g, "")
        console.log(`[findRecentProposal] fallback found: ${id.slice(0,8)} age:${age.toFixed(0)}s`)
        return { id, page: row }
      }
    }
  } catch (e) {
    console.warn("[findRecentProposal]", e.message)
  }
  return null
}

// ── Find inline Products & Services DB on a page ──────────────────────────
async function findLineItemsDB(pageId) {
  try {
    const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`, {
      headers: hdrs(),
    })
    if (!r.ok) return null
    const blocks = (await r.json()).results || []
    // Check direct children AND inside callouts
    const callouts = blocks.filter(b => b.type === "callout")
    const inner = await Promise.all(
      callouts.map(async b => {
        try {
          const nb = await fetch(`https://api.notion.com/v1/blocks/${b.id}/children`, { headers: hdrs() })
          return nb.ok ? (await nb.json()).results || [] : []
        } catch { return [] }
      })
    )
    const allBlocks = [...blocks, ...inner.flat()]
    const dbBlock = allBlocks.find(b => b.type === "child_database")
    if (dbBlock) return dbBlock.id.replace(/-/g, "")
  } catch (e) {
    console.warn("[findLineItemsDB]", e.message)
  }
  return null
}

// ── Create Products & Services inline DB on the proposal page ─────────────
async function createLineItemsDB(pageId) {
  // Callout header
  await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: "PATCH", headers: hdrs(),
    body: JSON.stringify({ children: [{
      type: "callout",
      callout: {
        rich_text: [{ type: "text", text: { content: "Products & Services" }, annotations: { bold: true } }],
        icon: null, color: "default_background",
      },
    }] }),
  })

  // Inline DB
  const r = await fetch("https://api.notion.com/v1/databases", {
    method: "POST", headers: hdrs(),
    body: JSON.stringify({
      parent:    { type: "page_id", page_id: pageId },
      is_inline: true,
      title:     [{ type: "text", text: { content: "Products & Services" } }],
      properties: {
        "Notes":               { title: {} },
        "Product":             { relation: { database_id: DB.CATALOGUE, single_property: {} } },
        "Product Description": { rich_text: {} },
        "Unit Price":          { number: { format: "ringgit" } },
        "Qty":                 { number: { format: "number" } },
        "Subtotal":            { formula: { expression: 'prop("Qty") * prop("Unit Price")' } },
      },
    }),
  })
  if (!r.ok) throw new Error(`Create DB: ${r.status} ${(await r.text()).slice(0, 150)}`)
  const db = await r.json()
  return db.id.replace(/-/g, "")
}

// ── Get existing placeholder rows from the inline DB ──────────────────────
async function getExistingRows(dbId) {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST", headers: hdrs(),
      body: JSON.stringify({ page_size: 50 }),
    })
    if (!r.ok) return []
    return (await r.json()).results || []
  } catch (e) {
    console.warn("[getExistingRows]", e.message)
    return []
  }
}

// ── Fill an existing placeholder row with product data ─────────────────────
async function fillRow(rowId, product) {
  const props = {
    "Qty": { number: 1 },
    ...(product.id        ? { "Product":   { relation: [{ id: product.id }] } } : {}),
    ...(product.price != null ? { "Unit Price": { number: Number(product.price) } } : {}),
    ...(product.description ? { "Product Description": { rich_text: [{ text: { content: product.description.slice(0, 2000) } }] } } : {}),
  }
  // Try with description col first, then without
  for (const descCol of product.description ? ["Product Description", "Description", "Details", null] : [null]) {
    const p = descCol
      ? { ...props, [descCol]: { rich_text: [{ text: { content: product.description.slice(0, 2000) } }] } }
      : props
    const r = await fetch(`https://api.notion.com/v1/pages/${rowId}`, {
      method: "PATCH", headers: hdrs(),
      body: JSON.stringify({ properties: p }),
    })
    if (r.ok) return
  }
}

// ── Create a new line item row ─────────────────────────────────────────────
async function createLineItem(dbId, product) {
  const baseProps = {
    "Notes": { title: [] },
    "Qty":   { number: 1 },
    ...(product.id    ? { "Product":   { relation: [{ id: product.id }] } } : {}),
    ...(product.price != null ? { "Unit Price": { number: Number(product.price) } } : {}),
  }
  const descCols = product.description ? ["Product Description", "Description", "Details"] : []
  for (const col of [...descCols, null]) {
    const props = col
      ? { ...baseProps, [col]: { rich_text: [{ text: { content: product.description.slice(0, 2000) } }] } }
      : baseProps
    const r = await fetch("https://api.notion.com/v1/pages", {
      method: "POST", headers: hdrs(),
      body:   JSON.stringify({ parent: { database_id: dbId }, properties: props }),
    })
    if (r.ok) return
    if (col === null) console.warn("[createLineItem] failed:", r.status)
  }
}

// ─── Convert Lead → Deal ──────────────────────────────────────────────────────
// Called by ?type=deal  (Notion "Convert to Deal" button on Leads page)
//
// Button setup — two actions:
//   Action 1: "Add page to Deals DB" — Notion creates the Deal page from template.
//             In the button config, set "Lead Source" = current Lead page.
//             This creates the bidirectional link before the webhook fires.
//   Action 2: "Send webhook" → POST /api/create_proposal with {"type":"deal"}
//             Webhook finds the newly created Deal via Lead.Deal relation,
//             patches all data in, advances Lead stage → Converted.
//
// Fallback: if the two-action button isn't set up, the handler creates
// the Deal page itself (same end result).

async function findDealFromLead(leadProps, maxAgeSeconds = 180) {
  // Primary: check the Lead.Deal relation (set by Action 1 button)
  const dealIds = (leadProps.Deal?.relation || []).map(r => r.id.replace(/-/g, ""))
  for (const id of dealIds) {
    try {
      const dp = await getPage(id, process.env.NOTION_API_KEY)
      const age = (Date.now() - new Date(dp.created_time).getTime()) / 1000
      if (age < maxAgeSeconds) return dp
    } catch {}
  }
  return null
}

async function handleConvertToDeal(leadId, res) {
  const token = process.env.NOTION_API_KEY
  const lead  = await getPage(leadId, token)
  const lp    = lead.properties

  const companyIds    = (lp.Company?.relation    || []).map(r => r.id.replace(/-/g, ""))
  const picIds        = (lp["Primary Contact"]?.relation || lp["PIC Name"]?.relation || []).map(r => r.id.replace(/-/g, ""))
  const osInterest    = lp["OS Interest"]?.select?.name || ""
  const addons        = (lp["Add-ons"]?.multi_select || []).map(a => a.name)
  const sourcedFrom   = (lp.Source?.multi_select || []).map(s => ({ name: s.name }))
  const situation     = plain(lp.Situation?.rich_text || [])
  const notes         = plain(lp.Notes?.rich_text     || [])
  const leadName      = plain(lp["Lead Name"]?.title   || [])
  const discoveryCall = lp["Discovery Call"]?.date?.start || null

  // ── Fetch quotation amount for Deal Value ─────────────────────────────────
  const quotationIds = (lp.Quotations?.relation || []).map(r => r.id.replace(/-/g, ""))
  let quotationId    = quotationIds[0] || null
  let dealValue      = 0
  if (quotationId) {
    try {
      const qp  = await getPage(quotationId, token)
      dealValue = qp.properties.Amount?.number || 0
    } catch {}
  }

  // ── Find or create the Deal page ──────────────────────────────────────────
  let dealPage = await findDealFromLead(lp)
  let dealId

  if (dealPage) {
    dealId = dealPage.id.replace(/-/g, "")
    console.log(`[convert_to_deal] found existing deal page: ${dealId}`)
  } else {
    dealPage = await createPage({
      parent: { database_id: DB.DEALS },
      properties: {
        "Lead Name":   { title: [{ text: { content: leadName } }] },
        "Stage":       { status: { name: "Scoping" } },
        "Client Type": { select: { name: "New Client" } },
        "Lead Source": { relation: [{ id: leadId }] },
      },
    }, token)
    dealId = dealPage.id.replace(/-/g, "")
    console.log(`[convert_to_deal] created new deal page: ${dealId}`)
  }

  // ── Patch all Lead data into the Deal ─────────────────────────────────────
  await patchPage(dealId, {
    "Stage":       { status: { name: "Scoping" } },
    "Client Type": { select: { name: "New Client" } },
    "Lead Source": { relation: [{ id: leadId }] },
    ...(leadName          ? { "Lead Name":    { title: [{ text: { content: leadName } }] } } : {}),
    ...(companyIds.length ? { "Company":      { relation: [{ id: companyIds[0] }] } } : {}),
    ...(picIds.length     ? { "Primary Contact": { relation: [{ id: picIds[0]   }] } } : {}),
    ...(osInterest        ? { "Package Type": { select: { name: osInterest } } } : {}),
    ...(addons.length     ? { "Add-ons":      { multi_select: addons.map(n => ({ name: n })) } } : {}),
    ...(sourcedFrom.length? { "Source":       { multi_select: sourcedFrom } } : {}),
    ...(dealValue         ? { "Deal Value":   { number: dealValue } } : {}),
    ...(quotationId       ? { "Quotation":    { relation: [{ id: quotationId }] } } : {}),
    ...(situation         ? { "Situation":    { rich_text: [{ text: { content: situation } }] } } : {}),
    ...(notes             ? { "Notes":        { rich_text: [{ text: { content: notes } }] } } : {}),
    ...(discoveryCall     ? { "Discovery Call":{ date: { start: discoveryCall } } } : {}),
  }, token)

  // ── Link Quotation's Deal Source → new Deal ───────────────────────────────
  if (quotationId) {
    await patchPage(quotationId, { "Deal Source": { relation: [{ id: dealId }] } }, token).catch(() => {})
  }

  // ── Update Lead: link Deal, Stage stays Discovery Done ────────────────────
  await patchPage(leadId, {
    "Deal":  { relation: [{ id: dealId }] },
    "Stage": { status: { name: "Discovery Done" } },
  }, token)

  console.log(`[convert_to_deal] ✓ lead ${leadId} → deal ${dealId}`)
  return res.status(200).json({ status: "ok", leadId, dealId, dealUrl: dealPage.url })
}

// ─── Main processing ─────────────────────────────────────────────────────────
async function processProposal(sourceId) {
  const token = process.env.NOTION_API_KEY

  // ── 1. Detect source — Lead or Deal ───────────────────────────────────────
  const sourcePage  = await getPage(sourceId, token)
  const sourceProps = sourcePage.properties
  const parentDb    = (sourcePage.parent?.database_id || "").replace(/-/g, "")
  const isFromDeal  = parentDb === DB.DEALS
  let   leadId      = isFromDeal ? null : sourceId
  const dealId      = isFromDeal ? sourceId : null

  // Resolve Lead ID from Deal's Origin Lead relation (for stitching Lead Source on proposal)
  if (isFromDeal && !leadId) {
    leadId = (sourceProps["Origin Lead"]?.relation || [])[0]?.id?.replace(/-/g, "") || null
    if (leadId) console.log("[create_proposal] resolved leadId from deal:", leadId)
  }

  console.log("[create_proposal] source:", isFromDeal ? "deal" : "lead", sourceId)

  const companyIds = (sourceProps.Company?.relation || []).map(r => r.id.replace(/-/g, ""))
  let picIds = []
  for (const f of ["Primary Contact", "PIC Name", "PIC", "Contact", "Person in Charge"]) {
    picIds = (sourceProps[f]?.relation || []).map(r => r.id.replace(/-/g, ""))
    if (picIds.length) break
  }

  // ── Check if client already has Base OS installed ─────────────────────────
  // Look up Client Accounts linked to this company — if "Base OS" is in OS Installed,
  // skip adding it as a line item (already installed, no need to charge again)
  let baseOsAlreadyInstalled = false
  if (companyIds.length) {
    try {
      const caRows = await queryDB(DB.CLIENT_ACCOUNTS, {
        property: "Company", relation: { contains: companyIds[0] }
      }, token)
      for (const ca of caRows) {
        const osInstalled = (ca.properties["OS Installed"]?.multi_select || []).map(x => x.name)
        if (osInstalled.includes("Base OS")) { baseOsAlreadyInstalled = true; break }
      }
      console.log("[create_proposal] baseOsAlreadyInstalled:", baseOsAlreadyInstalled)
    } catch (e) {
      console.warn("[create_proposal] client account lookup:", e.message)
    }
  }

  // Resolve OS type:
  // - Lead: "OS Interest" multi_select (use first value) or select
  // - Deal: "OS Type" relation to Catalogue (fetch the page) or "Packages" multi_select (first value)
  let osName = ""
  let slug   = ""
  if (isFromDeal) {
    // Primary: OS Type relation → fetch Catalogue item
    const osTypeIds = (sourceProps["OS Type"]?.relation || []).map(r => r.id.replace(/-/g, ""))
    if (osTypeIds.length) {
      try {
        const osPg = await getPage(osTypeIds[0], token)
        osName = plain(osPg.properties["Product Name"]?.title || "")
        slug   = plain(osPg.properties["Slug"]?.rich_text || "")
      } catch {}
    }
    // Fallback: Packages multi_select first value
    if (!osName) {
      const pkgs = (sourceProps["Packages"]?.multi_select || []).map(x => x.name)
      osName = pkgs[0] || ""
    }
  } else {
    // Lead: OS Interest (multi_select first or select)
    const oiMulti = (sourceProps["OS Interest"]?.multi_select || []).map(x => x.name)
    osName = oiMulti[0] || sourceProps["OS Interest"]?.select?.name || ""
  }
  if (!slug) slug = OS_TYPE_SLUG_MAP[osName.toLowerCase().trim()] || ""
  console.log("[create_proposal] osName:", osName, "slug:", slug)

  // ── Detect client currency from Lead Country ──────────────────────────────
  const country  = sourceProps.Country?.select?.name || ""
  const currency = COUNTRY_CURRENCY[country] || "MYR"
  const priceField = currency === "MYR" ? "Price (MYR)" : "Price (USD)"
  console.log("[create_proposal] country:", country, "→ currency:", currency)

  const addonNames = []
  let directAddonProducts = []  // built directly from Catalogue relation pages — no slug re-lookup
  const addonSlugs = []         // fallback only (multi_select path has no Catalogue page to read)

  // Deals: Add-ons is a relation to Catalogue. Leads: "Add-On Interest" is a relation to Catalogue.
  const addonRelationIds = (
    sourceProps["Add-On Interest"]?.relation ||
    sourceProps["Add-ons"]?.relation ||
    sourceProps["Add-Ons"]?.relation ||
    []
  ).map(r => r.id.replace(/-/g, ""))
  if (addonRelationIds.length) {
    // Fetch Catalogue items directly — build product objects from the page data.
    // This avoids the slug re-lookup and ensures add-ons without a Slug field still appear.
    const addonPages = await Promise.all(addonRelationIds.map(id => getPage(id, token).catch(() => null)))
    for (const ap of addonPages.filter(Boolean)) {
      const name = plain(ap.properties["Product Name"]?.title || [])
      if (!name) continue
      addonNames.push(name)
      directAddonProducts.push({
        id:          ap.id.replace(/-/g, ""),
        name,
        price:       ap.properties[priceField]?.number ?? ap.properties["Price (MYR)"]?.number ?? null,
        quote_type:  ap.properties["Quote Type"]?.select?.name || "New Business",
        description: plain(ap.properties["Description"]?.rich_text || []),
        slug:        plain(ap.properties["Slug"]?.rich_text || []),
      })
    }
  } else {
    // Leads fallback: multi_select — no page data, fall back to slug lookup
    for (const item of (sourceProps["Add-ons"]?.multi_select || sourceProps["Add-Ons"]?.multi_select || [])) {
      addonNames.push(item.name)
      const k = item.name.toLowerCase().trim()
      for (const [key, val] of Object.entries(ADDON_SLUG_MAP)) {
        if (k.includes(key)) { addonSlugs.push(val); break }
      }
    }
  }

  const isOS = OS_PACKAGE_SLUGS.has(slug)
  const [mainProduct, baseProduct, ...slugAddonProducts] = await Promise.all([
    slug ? fetchProductInfo(slug, currency) : Promise.resolve(null),
    isOS ? fetchProductInfo("base-os", currency) : Promise.resolve(null),
    ...addonSlugs.map(s => fetchProductInfo(s, currency)),
  ])
  // Use directly-built addon products when available (relation path); slug-fetched as fallback (multi_select path)
  const addonProducts = directAddonProducts.length ? directAddonProducts : slugAddonProducts

  console.log("[create_proposal] slug:", slug, "osName:", osName, "addons:", addonProducts.length, "fromDeal:", isFromDeal)

  // ── 2. Find recently created Proposal page ─────────────────────────────────
  // Notion button Action 1 creates the proposal before Action 2 fires the
  // webhook, so the relation should already be populated. Try it immediately,
  // then fall to time-based scan — no sleep needed.
  let recent = await findProposalFromLead(sourceProps)
  if (!recent) {
    // Relation not set yet (race) — scan by recency directly
    console.log("[create_proposal] relation empty — scanning by recency")
    recent = await findRecentProposal(300) // 5-min window
  }

  let propId
  if (recent) {
    propId = recent.id
    console.log("[create_proposal] found proposal:", propId)
  } else {
    const today = new Date().toISOString().split("T")[0]
    const newProp = await createPage({
      parent: { database_id: DB.PROPOSALS },
      properties: {
        "Ref Number":    { title: [{ text: { content: "" } }] },
        "Status":        { status: { name: "Draft" } },
        "Date":          { date: { start: today } },
        "Payment Terms": { select: { name: "50% Deposit" } },
        ...(companyIds.length ? { "Company":      { relation: [{ id: companyIds[0] }] } } : {}),
        ...(picIds.length     ? { "Primary Contact": { relation: [{ id: picIds[0] }] } } : {}),
        ...(dealId        ? { "Deal Source":      { relation: [{ id: dealId }] } } : {}),
      },
    }, token)
    propId = newProp.id.replace(/-/g, "")
    console.log("[create_proposal] fallback created:", propId)
  }

  // ── 3. Patch Proposal properties ───────────────────────────────────────────
  const today      = new Date().toISOString().split("T")[0]
  const validUntilD = new Date(); validUntilD.setDate(validUntilD.getDate() + 30)
  const validUntil  = validUntilD.toISOString().split("T")[0]
  const situation  = plain(sourceProps.Situation?.rich_text || [])

  // Add-Ons: relation to Catalogue (addonProducts already have .id from Catalogue lookup)
  const addonRelIds = addonProducts.filter(Boolean).map(p => ({ id: p.id }))

  await patchPage(propId, {
    "Status":        { status: { name: "Draft" } },
    "Date":          { date: { start: today } },
    "Valid Until":   { date: { start: validUntil } },
    "Payment Terms": { select: { name: "50% Deposit" } },
    "Currency":      { select: { name: currency } },
    ...(addonRelIds.length                    ? { "Add-Ons":         { relation: addonRelIds } } : {}),
    ...(mainProduct?.quote_type               ? { "Quote Type":      { select:   { name: mainProduct.quote_type } } } : {}),
    ...(mainProduct?.id                       ? { "OS Packages":     { relation: [{ id: mainProduct.id }] } } : {}),
    ...(companyIds.length                     ? { "Company":         { relation: [{ id: companyIds[0] }] } } : {}),
    ...(picIds.length                         ? { "Primary Contact": { relation: [{ id: picIds[0] }] } } : {}),
    ...(dealId                                ? { "Deal Source":     { relation: [{ id: dealId }] } } : {}),
    ...(situation                             ? { "Situation":       { rich_text: [{ text: { content: situation.slice(0, 2000) } }] } } : {}),
  }, token)

  // ── Stitch both ways: Lead.Proposals → this proposal ─────────────────────
  // Notion's DUAL auto-sync is unreliable via API — always stitch explicitly
  if (leadId) {
    try {
      const leadPage  = await getPage(leadId, token)
      const existing  = (leadPage.properties["Proposals"]?.relation || []).map(r => ({ id: r.id }))
      const alreadyIn = existing.some(r => r.id.replace(/-/g, "") === propId)
      if (!alreadyIn) {
        await patchPage(leadId, {
          "Proposals": { relation: [...existing, { id: propId }] }
        }, token)
        console.log("[create_proposal] stitched Lead.Proposals →", propId)
      }
    } catch (e) {
      console.warn("[create_proposal] stitch Lead.Proposals:", e.message)
    }
  }

  // ── 4. Line Items DB ───────────────────────────────────────────────────────
  // Template (created by Notion button Action 1) always includes the inline
  // Products & Services DB. Just find it — never create a second one.
  // Retry up to 4 times (2 s gap) to handle template render lag.
  let dbId = null
  for (let attempt = 0; attempt < 4; attempt++) {
    dbId = await findLineItemsDB(propId)
    if (dbId) break
    console.log(`[create_proposal] DB not found yet, retry ${attempt + 1}/4…`)
    await new Promise(r => setTimeout(r, 2000))
  }

  if (!dbId) {
    // Template DB missing — skip line items, don't create a duplicate
    console.warn("[create_proposal] inline DB not found after retries — skipping line items")
    return { propId, productName: mainProduct?.name ?? null, lineItemsCount: 0, warning: "inline_db_not_found" }
  }

  // ── 5. Fill line items ─────────────────────────────────────────────────────
  const lineItems = []
  // Only include Base OS if client doesn't already have it installed
  if (isOS && baseProduct?.id && !baseOsAlreadyInstalled) lineItems.push(baseProduct)
  if (mainProduct?.id)         lineItems.push(mainProduct)
  lineItems.push(...addonProducts.filter(Boolean))

  // Archive existing template placeholder rows then create fresh rows in the
  // correct order: Base OS → Main OS → Add-ons
  const existingRows = await getExistingRows(dbId)
  if (existingRows.length > 0) {
    await Promise.all(existingRows.map(row =>
      fetch(`https://api.notion.com/v1/pages/${row.id}`, {
        method: "PATCH", headers: hdrs(),
        body: JSON.stringify({ archived: true }),
      }).catch(() => {})
    ))
  }
  console.log(`[create_proposal] archived ${existingRows.length} template rows, creating ${lineItems.length} fresh`)

  // Create line items in order: Base OS → Main OS → Add-ons
  for (const product of lineItems) {
    await createLineItem(dbId, product)
  }

  // ── 5b. Write Amount (MYR) to Proposal ────────────────────────────────────
  // Sum prices of all line items (Base OS is complimentary → price 0, excluded from total)
  const totalAmount = lineItems.reduce((sum, p) => sum + (p?.price ?? 0), 0)
  if (totalAmount > 0) {
    try {
      await patchPage(propId, { "Amount": { number: totalAmount } }, token)
      console.log(`[create_proposal] Amount (MYR): ${totalAmount}`)
    } catch (e) {
      console.warn("[create_proposal] amount patch:", e.message)
    }
  }

  // ── 6. Advance Deal stage → Proposal Sent ────────────────────────────────
  // Proposal sent — move the Deal forward. Lead stage is not touched here.
  try {
    if (dealId) {
      await patchPage(dealId, {
        "Stage": { status: { name: "Proposal Sent" } },
      }, process.env.NOTION_API_KEY)
      console.log(`[create_proposal] deal ${dealId} → Proposal Sent`)
    }
  } catch (e) {
    console.warn("[create_proposal] deal stage update:", e.message)
  }

  console.log(`[create_proposal] ✓ prop ${propId} — ${lineItems.length} line items, source: ${isFromDeal ? "deal" : "lead"}`)
  return { propId, productName: mainProduct?.name ?? null, lineItemsCount: lineItems.length }
}

// ─────────────────────────────────────────────────────────────────────────────
export async function handler(req, res) {
  if (req.method === "GET") return res.json({ service: "Opxio — Create Proposal", status: "ready" })
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const body  = req.body || {}
  const rawId = body.page_id || body.source?.page_id || body.data?.page_id || body.data?.id
  if (!rawId) return res.status(400).json({ error: "Missing page_id" })
  const sourceId = rawId.replace(/-/g, "")

  // Route to Convert to Deal handler if type=deal
  if ((body.type || req.query.type) === "deal") {
    return handleConvertToDeal(sourceId, res).catch(e => {
      console.error("[convert_to_deal] error:", e.message)
      return res.status(500).json({ error: e.message })
    })
  }

  try {
    const result = await processProposal(sourceId)
    return res.status(200).json({ status: "ok", ...result })
  } catch (e) {
    console.error("[create_proposal] error:", e.message, e.stack)
    return res.status(500).json({ error: e.message })
  }
}