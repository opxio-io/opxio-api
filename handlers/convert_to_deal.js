// ─── convert_to_deal.js ────────────────────────────────────────────────────
// POST /api/convert_to_deal   { "page_id": "<lead_page_id>" }
// Triggered by Notion button "Convert to Deal" on a Lead page.
//
// 1. Reads Lead: Company, Primary Contact, OS Interest (all), Add-On Interest,
//    Source, Situation, Discovery Call, Potential Value, Country,
//    Industry, Team Size, Notes
// 2. Fetches Company name for Deal title
// 3. Creates Deal in Deals DB  ── Deal Name: "Company Name — Product"
// 4. Stitches: Deal["Origin Lead"] → Lead, Lead["Deal"] → Deal
// 5. Updates Lead Stage → "Converted"
// 6. Enriches Company: Industry, Team Size, Country, Billing Currency
// 7. Marks Contact as Primary Contact, ensures Company relation is set

import { getPage, patchPage, createPage, plain, DB, createTeamTask } from "../../lib/notion"

// ─── Catalogue page IDs for each OS (OS Type relation in Deals) ────────────
const CATALOGUE_OS_IDS = {
  "Revenue OS":               "e28fe60097f682bf8ec381fd1a4b6950",
  "Operations OS":            "448fe60097f6837a9f86014edd5503c2",
  "Finance OS":               "345fe60097f681bfa6bcd1e10295b691",
  "Marketing OS":             "56cfe60097f683d5ac4181d560bb6a0d",
  "Team OS":                  "33ffe60097f681e4a675d960f861230e",
  "Retention OS":             "33ffe60097f681a68d47d7a508f86e26",
  "Sales OS":                 "33ffe60097f681a68d47d7a508f86e27",
  "Micro Install":            "340fe60097f681b2a577f05541116703",
  "Micro Install — 1 Module": "340fe60097f681b2a577f05541116703",
  "Micro Install — 2 Modules":"340fe60097f68112a63ac60a7599d0c0",
  "Micro Install — 3 Modules":"340fe60097f68112b5e2e49bd87cfb35",
}

// ─── Country → Billing Currency ───────────────────────────────────────────
const COUNTRY_CURRENCY = {
  "Malaysia":    "MYR",
  "Singapore":   "SGD",
  "Indonesia":   "IDR",
  "Philippines": "PHP",
  "Thailand":    "THB",
  "Vietnam":     "VND",
  "Bangladesh":  "BDT",
  "India":       "INR",
  "UK":          "GBP",
  "Australia":   "AUD",
  "USA":         "USD",
  "Canada":      "CAD",
}

// ─── Map Lead Source → Deal Source ────────────────────────────────────────
function mapLeadSourceToDeal(leadSources) {
  if (!leadSources || leadSources.length === 0) return null
  const names = leadSources.map(s => s.name)
  if (names.includes("Referral"))      return "New Client — Referral"
  if (names.includes("Cold Outreach")) return "New Client — Outbound"
  return "New Client — Inbound"
}

// ─── Safe relation append ──────────────────────────────────────────────────
async function appendRelation(pageId, property, newId, token) {
  const page     = await getPage(pageId, token)
  const existing = (page.properties?.[property]?.relation || []).map(r => ({ id: r.id }))
  if (existing.some(r => r.id === newId)) return
  await patchPage(pageId, {
    [property]: { relation: [...existing, { id: newId }] },
  }, token)
}

// ─── Main run ─────────────────────────────────────────────────────────────
async function run(payload) {
  const rawId = payload.page_id
    || payload.data?.id
    || payload.data?.page_id
    || payload.source?.page_id
    || payload.source?.id
  if (!rawId) throw new Error("Missing page_id")

  const leadId = rawId.replace(/-/g, "")
  const token  = process.env.NOTION_API_KEY

  // ── 1. Read Lead ──────────────────────────────────────────────────────────
  const lead  = await getPage(leadId, token)
  const lp    = lead.properties

  const companyRel = lp.Company?.relation?.[0]?.id?.replace(/-/g, "") || null

  const contactRel = (
    lp["Primary Contact"]?.relation ||
    lp["PIC Name"]?.relation ||
    []
  )[0]?.id?.replace(/-/g, "") || null

  // All selected OS interests (multi_select) — not just the first
  const osInterestAll  = lp["OS Interest"]?.multi_select?.map(s => s.name) || []
  const osInterestPrimary = osInterestAll[0] || null

  // Add-On Interest — relation to Catalogue items, copy IDs directly to Deal
  const addonInterestIds = (lp["Add-On Interest"]?.relation || [])
    .map(r => ({ id: r.id.replace(/-/g, "") }))

  const situation     = plain(lp.Situation?.rich_text || [])
  const discoveryCall = lp["Discovery Call"]?.date?.start || null
  const potentialVal  = lp["Potential Value"]?.formula?.number
                     ?? lp["Potential Value"]?.number
                     ?? null
  const country       = lp.Country?.select?.name || null
  const industry      = lp.Industry?.select?.name || null
  const teamSize      = lp["Team Size"]?.select?.name || null
  const notes         = plain(lp.Notes?.rich_text || [])

  const leadSourceArr  = lp.Source?.multi_select || []
  const dealSourceName = mapLeadSourceToDeal(leadSourceArr)

  // Map all OS interests to Catalogue relation IDs
  const catalogueOsIds = osInterestAll
    .filter(os => os !== "Not Sure Yet" && CATALOGUE_OS_IDS[os])
    .map(os => ({ id: CATALOGUE_OS_IDS[os] }))

  // ── 2. Fetch Company name ─────────────────────────────────────────────────
  let companyName = ""
  if (companyRel) {
    try {
      const cp = await getPage(companyRel, token)
      for (const v of Object.values(cp.properties)) {
        if (v.type === "title") { companyName = plain(v.title); break }
      }
    } catch (e) {
      console.warn("[convert_to_deal] company fetch:", e.message)
    }
  }

  // ── 3. Build Deal Name ────────────────────────────────────────────────────
  // Primary OS for the name — if multiple, join them
  const productLabel = osInterestAll.filter(os => os !== "Not Sure Yet").join(" + ") || "System OS"
  const dealName = companyName
    ? `${companyName} — ${productLabel}`
    : `New Deal — ${productLabel}`

  // ── 4. Create Deal ────────────────────────────────────────────────────────
  const dealProps = {
    "Deal Name":   { title: [{ text: { content: dealName } }] },
    "Stage":       { status: { name: "Scoping" } },
    "Origin Lead": { relation: [{ id: leadId }] },
  }

  if (companyRel)                   dealProps["Company"]         = { relation: [{ id: companyRel }] }
  if (contactRel)                   dealProps["Primary Contact"] = { relation: [{ id: contactRel }] }
  if (situation)                    dealProps["Situation"]       = { rich_text: [{ text: { content: situation } }] }
  if (discoveryCall)                dealProps["Discovery Call"]  = { date: { start: discoveryCall } }
  if (potentialVal)                 dealProps["Deal Value"]      = { number: potentialVal }
  if (notes)                        dealProps["Notes"]           = { rich_text: [{ text: { content: notes } }] }
  if (dealSourceName)               dealProps["Source"]          = { select: { name: dealSourceName } }
  if (catalogueOsIds.length > 0)   dealProps["OS Type"]         = { relation: catalogueOsIds }
  if (addonInterestIds.length > 0) dealProps["Add-ons"]         = { relation: addonInterestIds }

  const dealPage = await createPage({
    parent:     { database_id: DB.DEALS },
    properties: dealProps,
  }, token)
  const dealId = dealPage.id.replace(/-/g, "")
  console.log("[convert_to_deal] Deal created:", dealId, dealName,
    "| os_types:", catalogueOsIds.length, "| addons:", addonInterestIds.length)

  // ── 5. Stitch: Lead["Deal"] → Deal ────────────────────────────────────────
  try {
    await appendRelation(leadId, "Deal", dealId, token)
  } catch (e) {
    console.warn("[convert_to_deal] stitch Lead→Deal:", e.message)
  }

  // ── 6. Update Lead Stage → Converted ─────────────────────────────────────
  try {
    await patchPage(leadId, { "Stage": { status: { name: "Converted" } } }, token)
  } catch (e) {
    console.warn("[convert_to_deal] lead stage update:", e.message)
  }

  // ── 7. Enrich Company with qualifying data from Lead ──────────────────────
  if (companyRel) {
    try {
      const companyUpdates = {}
      if (industry) companyUpdates["Industry"]        = { select: { name: industry } }
      if (teamSize) companyUpdates["Team Size"]       = { select: { name: teamSize } }
      if (country)  companyUpdates["Country"]         = { select: { name: country } }
      const currency = country ? COUNTRY_CURRENCY[country] : null
      if (currency) companyUpdates["Billing Currency"] = { select: { name: currency } }

      if (Object.keys(companyUpdates).length > 0) {
        await patchPage(companyRel, companyUpdates, token)
        console.log("[convert_to_deal] Company enriched:", companyName)
      }
    } catch (e) {
      console.warn("[convert_to_deal] company enrich:", e.message)
    }
  }

  // ── 8. Enrich Contact: mark as Primary Contact + ensure Company is set ─────
  if (contactRel) {
    try {
      const contactPage  = await getPage(contactRel, token)
      const contactProps = {}

      // Mark as Primary Contact
      contactProps["Primary Contact"] = { checkbox: true }

      // Set Company relation if missing
      const existingCompany = contactPage.properties?.Company?.relation?.[0]?.id
      if (!existingCompany && companyRel) {
        contactProps["Company"] = { relation: [{ id: companyRel }] }
      }

      await patchPage(contactRel, contactProps, token)
      console.log("[convert_to_deal] Contact enriched:", contactRel)
    } catch (e) {
      console.warn("[convert_to_deal] contact enrich:", e.message)
    }
  }

  // ── 9. Auto-create Team Task — send proposal ──────────────────────────────
  await createTeamTask({
    taskName:  `Prepare quotation — ${companyName || dealName}`,
    category:  "Sales",
    priority:  "High",
    dealId,
    companyId: companyRel || undefined,
  })

  return {
    status:       "success",
    lead_id:      leadId,
    deal_id:      dealId,
    deal_name:    dealName,
    deal_source:  dealSourceName,
    os_types:     catalogueOsIds.length,
    addons:       addonInterestIds.length,
    deal_url:     dealPage.url || `https://notion.so/${dealId}`,
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────
export async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Convert to Deal", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    const result = await run(req.body || {})
    return res.json(result)
  } catch (e) {
    console.error("[convert_to_deal]", e)
    return res.status(500).json({ error: e.message })
  }
}