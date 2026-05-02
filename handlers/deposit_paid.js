// ─── deposit_paid.js ───────────────────────────────────────────────────────
// POST /api/deposit_paid   { "page_id": "<invoice_page_id>" }
// Triggered by Notion button "Mark Deposit Paid" on Invoice page.

import { getPage, patchPage, createPage, queryDB, plain, DB, createLedgerEntry, hdrs, createTeamTask } from "../../lib/notion"
import { waitUntil } from "@vercel/functions"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import crypto from "crypto"

// ── Create Supabase portal record for new client ─────────────────────────
async function createPortalClient({ companyName, projectId, contactEmail, packages }) {
  try {
    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
    )

    const portalToken  = crypto.randomBytes(48).toString("hex")
    const accessToken  = crypto.randomBytes(32).toString("hex")
    const slug = (companyName || "client")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      + "-" + Date.now().toString(36)

    const { data, error } = await supabase.from("clients").insert({
      client_name:   companyName || "New Client",
      slug,
      status:        "active",
      access_token:  accessToken,
      portal_token:  portalToken,
      project_id:    projectId,
      portal_active: true,
      os_type:       packages || [],
      notion_token:  process.env.NOTION_API_KEY,
      databases:     {},
      field_map:     {},
      labels:        {},
      custom_widgets:[],
    }).select("id,portal_token,slug").single()

    if (error) {
      console.warn("[deposit_paid] createPortalClient supabase error:", error.message)
      return null
    }

    console.log("[deposit_paid] Portal client created:", data.slug, "token:", portalToken.slice(0,8) + "…")
    return { portalToken, supabaseId: data.id, slug }
  } catch (e) {
    console.warn("[deposit_paid] createPortalClient:", e.message)
    return null
  }
}

// ── Send portal activation email ─────────────────────────────────────────
async function sendPortalEmail({ email, firstName, companyName, portalToken }) {
  if (!email) return
  const portalUrl = `https://app.opxio.io/portal/${portalToken}`
  if (!process.env.RESEND_API_KEY) {
    console.log("[deposit_paid] Portal link for", email, ":", portalUrl)
    return
  }
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Opxio <hello@opxio.io>",
      to: email,
      subject: "Your Opxio project portal is ready",
      html: `<div style="font-family:'Satoshi',Helvetica,sans-serif;background:#0D0D0D;color:#fff;padding:48px 36px;max-width:520px;margin:0 auto;border-radius:16px">
        <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:32px">
          <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#AAFF00;margin-right:8px;vertical-align:middle"></span>Opxio
        </div>
        <p style="font-size:15px;color:rgba(255,255,255,.5);margin-bottom:8px">Hi ${firstName || companyName || "there"},</p>
        <p style="font-size:15px;color:rgba(255,255,255,.5);margin-bottom:28px;line-height:1.7">Your deposit has been received — your build is now underway.<br>Track progress, view invoices, and send us requests from your portal.</p>
        <a href="${portalUrl}" style="display:inline-block;background:#AAFF00;color:#000;font-size:12px;font-weight:900;padding:13px 28px;border-radius:9px;text-decoration:none;letter-spacing:.02em;text-transform:uppercase">Access your portal →</a>
        <p style="font-size:11px;color:rgba(255,255,255,.15);margin-top:36px">— Opxio</p>
      </div>`,
    }),
  }).catch(e => console.warn("[deposit_paid] portal email:", e.message))
}

// ── Extract OS package + add-ons from any page's properties ─────────────────
// Works across Leads ("OS Interest" select + "Add-ons" multi_select)
// and Deals/Quotations ("Packages" multi_select).
const OS_NAMES = new Set([
  "Agency OS","Business OS","Marketing OS","Operations OS","Revenue OS",
  "Team OS","Retention OS","Intelligence OS","Starter OS",
  "Micro Install — 1 Module","Micro Install — 2 Modules","Micro Install — 3 Modules",
])
function extractPackageInfo(props) {
  // 1. Try "Packages" multi_select (on Deals and Quotations)
  const pkgMulti = (props["Packages"]?.multi_select || []).map(s => s.name)
  if (pkgMulti.length) {
    const osName = pkgMulti.find(n => OS_NAMES.has(n)) || pkgMulti[0]
    const addons = pkgMulti.filter(n => n !== osName)
    return { pkg: osName, addons }
  }
  // 2. Try "OS Interest" multi_select + "Add-ons" multi_select (on Leads)
  const osMulti  = (props["OS Interest"]?.multi_select || []).map(s => s.name)
  const osSel    = osMulti.find(n => OS_NAMES.has(n)) || osMulti[0] || props["Package Type"]?.select?.name || ""
  const addons   = [
    ...osMulti.filter(n => n !== osSel),
    ...(props["Add-ons"]?.multi_select || []).map(s => s.name),
  ]
  return { pkg: osSel, addons }
}

// ── Map Lead Entry Point → Client Origin ──────────────────────────────────
function mapClientOrigin(entryPoint = "") {
  if (!entryPoint) return null
  if (entryPoint === "Cold Outreach")  return "Outbound"
  if (entryPoint === "Referral Direct") return "Referral"
  return "Inbound"  // Notion Form, Website Form, WhatsApp Direct, LinkedIn DM, etc.
}

function cleanPhone(phone = "") {
  const digits = phone.replace(/\D/g, "")
  return digits.startsWith("0") ? "6" + digits : digits
}

async function getPicPhone(companyId, token) {
  try {
    const cp   = await getPage(companyId, token)
    const rels = cp.properties.People?.relation || cp.properties.Clients?.relation || []
    for (const rel of rels) {
      const pp = await getPage(rel.id.replace(/-/g, ""), token)
      if (pp.properties["Primary Contact"]?.checkbox) {
        for (const [, prop] of Object.entries(pp.properties)) {
          if (prop.type === "phone_number" && prop.phone_number) return prop.phone_number
        }
      }
    }
    if (rels.length) {
      const pp = await getPage(rels[0].id.replace(/-/g, ""), token)
      for (const [, prop] of Object.entries(pp.properties)) {
        if (prop.type === "phone_number" && prop.phone_number) return prop.phone_number
      }
    }
  } catch (e) {
    console.warn("[deposit_paid] getPicPhone:", e.message)
  }
  return ""
}

function buildWaUrl(phone, companyName, formUrl) {
  const phoneClean = cleanPhone(phone)
  if (!phoneClean) return ""
  const lines = [
    `Hi ${companyName}! 👋`, "",
    "Your deposit has been received — thank you!", "",
    "To kick off your onboarding, please fill in our Implementation Intake Form:",
    "", `📋 ${formUrl}`, "",
    "Looking forward to building with you!",
    "— Opxio",
  ]
  return `https://wa.me/${phoneClean}?text=${encodeURIComponent(lines.join("\n"))}`
}

// ── Create a Client Account record in the Client Accounts DB ─────────────
// Called when a deposit is marked as received. Creates the post-install client record
// and links it back to the Invoice's "Client Account" relation field.
async function createClientAccount({ invoiceId, companyId, companyName, dealId, leadId, picId, projectId, packages, packageCatalogueIds, addonCatalogueIds, formUrl, clientOrigin, today, token }) {
  try {
    const caProps = {
      "Account Name":  { title: [{ text: { content: companyName || "New Client" } }] },
      "Status":        { select: { name: "Active" } },
      "Client Health": { select: { name: "🟢 Healthy" } },
      "Install Date":  { date: { start: today } },
      ...(clientOrigin ? { "Client Origin": { select: { name: clientOrigin } } } : {}),
      ...(companyId  ? { "Company":         { relation: [{ id: companyId  }] } } : {}),
      ...(leadId     ? { "Linked Lead":     { relation: [{ id: leadId     }] } } : {}),
      ...(dealId     ? { "Linked Deal":     { relation: [{ id: dealId     }] } } : {}),
      ...(picId      ? { "Primary Contact": { relation: [{ id: picId      }] } } : {}),
      ...(projectId  ? { "Project Tracker": { relation: [{ id: projectId  }] } } : {}),
      ...(packageCatalogueIds?.length ? { "OS Installed": { relation: packageCatalogueIds.map(id => ({ id })) } } : {}),
      ...(addonCatalogueIds?.length ? { "Add-ons Installed": { relation: addonCatalogueIds.map(id => ({ id })) } } : {}),
    }

    const caPage = await createPage({ parent: { database_id: DB.CLIENT_ACCOUNTS }, properties: caProps }, token)
    const caId   = caPage.id.replace(/-/g, "")
    console.log("[deposit_paid] Client Account created:", caId)

    // Link Invoice → Client Account
    await patchPage(invoiceId, { "Client Account": { relation: [{ id: caId }] } }, token)
      .catch(e => console.warn("[deposit_paid] link invoice→client account:", e.message))

    // Back-link Project → Client Account
    if (projectId) {
      await patchPage(projectId, { "Client Account": { relation: [{ id: caId }] } }, token)
        .catch(e => console.warn("[deposit_paid] link project→client account:", e.message))
    }

    return caId
  } catch (e) {
    console.warn("[deposit_paid] createClientAccount:", e.message)
    return null
  }
}

async function triggerSetupProject(projectId, packages) {
  try {
    // Always use canonical URL — VERCEL_URL points to preview deployments, not production
    const r = await fetch("https://api.opxio.io/api/setup_project", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ page_id: projectId, packages }),
    })
    if (r.ok) {
      const d = await r.json()
      return [d.phases_created || 0, d.tasks_created || 0]
    }
    const errText = await r.text().catch(() => "")
    console.warn("[deposit_paid] setup_project non-ok:", r.status, errText)
  } catch (e) {
    console.warn("[deposit_paid] setup_project:", e.message)
  }
  return [0, 0]
}

async function run(payload) {
  const token  = process.env.NOTION_API_KEY
  const rawId  = payload.page_id
    || payload.data?.id           // Notion automation format
    || payload.data?.page_id
    || payload.source?.page_id
    || payload.source?.id
  if (!rawId) throw new Error("No page_id in payload")
  const pageId = rawId.replace(/-/g, "")

  const inv   = await getPage(pageId, token)
  const props = inv.properties

  const invType = props["Invoice Type"]?.select?.name || ""
  const status  = props.Status?.select?.name || ""
  if (invType === "Final Payment") throw new Error("This is a Final Payment invoice")
  if (status === "Deposit Received") throw new Error("Deposit already marked as received")

  const today = new Date().toISOString().split("T")[0]

  await patchPage(pageId, {
    "Status":       { status: { name: "Deposit Received" } },
    "Deposit Paid": { date: { start: today } },
  }, token)

  const companyId   = props.Company?.relation?.[0]?.id?.replace(/-/g, "") || null
  const picId       = props["Primary Contact"]?.relation?.[0]?.id?.replace(/-/g, "") || null
  let   quotationId = props.Quotation?.relation?.[0]?.id?.replace(/-/g, "") || null
  const implIdRaw   = props["Client Account"]?.relation?.[0]?.id?.replace(/-/g, "") || null
  // Invoice.Deal Source → Deals DB only (not Leads). Start null; set after conversion.
  let   leadId      = null  // will be resolved via Quotation.Lead Source or other fallbacks

  // ── Fallback 1: Check Quotation's "Lead Source" (Quotation → Leads DB) ────
  // NOTE: Quotation has two relation fields:
  //   "Lead Source"  → Leads DB  (set by create_quotation.js)
  //   "Deal Source"  → Deals DB  (set after Lead → Deal conversion)
  if (!leadId && quotationId) {
    try {
      const qp = await getPage(quotationId, token)
      leadId   = qp.properties["Lead Source"]?.relation?.[0]?.id?.replace(/-/g, "")
                 || qp.properties["Deal Source"]?.relation?.[0]?.id?.replace(/-/g, "")
                 || null
    } catch {}
  }
  // ── Fallback 2: Query Leads DB for Lead linked to this Quotation ─────────
  // NOTE: Leads DB uses "Quotations" (plural) as the relation field name
  if (!leadId && quotationId) {
    try {
      const rows = await queryDB(DB.LEADS, {
        property: "Quotations", relation: { contains: quotationId }
      }, token)
      if (rows.length) leadId = rows[0].id.replace(/-/g, "")
    } catch {}
  }
  // ── Fallback 3: Check Project's "Deal Source" (for manually-created invoices)
  if (!leadId && implIdRaw) {
    try {
      const pj = await getPage(implIdRaw, token)
      leadId   = pj.properties["Deal Source"]?.relation?.[0]?.id?.replace(/-/g, "") || null
    } catch {}
  }

  // ── Fetch Quotation amount (for Deal Value) ──────────────────────────────
  let quotationAmount = props["Amount"]?.number || props["Amount (MYR)"]?.number || props["Total Amount"]?.number || 0  // from Invoice

  // ── Fetch Quotation data (amount + packages) in one call ──────────────────
  let packageCatalogueIds = []
  let quotationPackageNames = []
  if (quotationId) {
    try {
      const qp = await getPage(quotationId, token)
      if (!quotationAmount) {
        quotationAmount = qp.properties["Amount"]?.number || qp.properties["Amount (MYR)"]?.number || 0
      }
      const pkgRels = qp.properties.Packages?.relation || []
      packageCatalogueIds = pkgRels.map(r => r.id.replace(/-/g, ""))
      // Fetch Catalogue item names for OS Scope fallback when formPackage is empty
      for (const rel of pkgRels) {
        try {
          const catItem = await getPage(rel.id.replace(/-/g, ""), token)
          for (const [, v] of Object.entries(catItem.properties)) {
            if (v.type === "title") {
              const nm = (v.title || []).map(t => t.plain_text).join("").trim()
              if (nm) quotationPackageNames.push(nm)
              break
            }
          }
        } catch {}
      }
    } catch {}
  }

  // ── Detect Lead vs Deal and advance stage / create Deal ─────────────────
  // leadId at this point is resolved from: Quotation.Lead Source → Leads DB
  // OR from: Quotation.Deal Source → Deals DB (existing Deal)
  // • Lead  → mark Lead "Converted", spin up a new Deal at "Closed-Won"
  // • Deal  → advance Deal to "Closed-Won" directly
  let dealId             = null  // will be set if we create or find a Deal
  let formPackage        = ""    // OS package name for onboarding form URL
  let formAddons         = []    // add-on names for onboarding form URL
  let clientOrigin       = null  // mapped from Lead Entry Point
  let addonCatalogueIds  = []    // Catalogue page IDs for add-ons (from Deal.Add-ons relation)

  if (leadId) {
    try {
      const sourcePage  = await getPage(leadId, token)
      const sourceDbId  = (sourcePage.parent?.database_id || "").replace(/-/g, "")
      const isLead      = sourceDbId === DB.LEADS.replace(/-/g, "")

      if (isLead) {
        // ── New client: Lead → Converted, create Deal at Building ─────────────
        const lp = sourcePage.properties
        const leadName      = plain(lp["Lead Name"]?.title || []) || "New Deal"
        const compIds       = (lp.Company?.relation       || []).map(r => r.id.replace(/-/g, ""))
        const picIds        = (lp["Primary Contact"]?.relation || lp["PIC Name"]?.relation || []).map(r => r.id.replace(/-/g, ""))
        const osInterest    = (lp["OS Interest"]?.multi_select || [])[0]?.name || ""
        const addons        = (lp["Add-ons"]?.multi_select || []).map(a => ({ name: a.name }))
        const situation     = plain(lp.Situation?.rich_text || [])
        const notes         = plain(lp.Notes?.rich_text     || [])
        const discoveryCall = lp["Discovery Call"]?.date?.start || null

        // Capture for onboarding form URL (prefer Lead's OS Interest + Add-ons)
        ;({ pkg: formPackage, addons: formAddons } = extractPackageInfo(lp))
        if (!formPackage) formPackage = osInterest

        // Map Entry Point → Client Origin
        clientOrigin = mapClientOrigin(lp["Entry Point"]?.select?.name || "")

        // ── Check if a Deal was already created (e.g., via "Convert to Deal") ──
        // If so, reuse it instead of creating a duplicate.
        const existingDealId = lp.Deal?.relation?.[0]?.id?.replace(/-/g, "") || null

        if (existingDealId) {
          // Deal already exists — advance its stage to Building and fill missing fields
          dealId = existingDealId
          try {
            const existingDeal = await getPage(existingDealId, token)
            const currentStage = existingDeal.properties.Stage?.status?.name || ""
            const doneStages   = ["Closed-Won", "Closed-Lost"]
            const dealPatches  = {
              ...(!doneStages.includes(currentStage) ? { "Stage": { status: { name: "Closed-Won" } } } : {}),
              // Fill Deal Value if not already set
              ...(quotationAmount && !existingDeal.properties["Deal Value"]?.number
                ? { "Deal Value": { number: quotationAmount } } : {}),
              // Link Quotation and Invoice to Deal
              ...(quotationId ? { "Quotation": { relation: [{ id: quotationId }] } } : {}),
              ...(pageId      ? { "Invoices":  { relation: [{ id: pageId }] } } : {}),
            }
            await patchPage(dealId, dealPatches, token)
            // Capture package info from the existing Deal for onboarding form
            if (!formPackage || !formAddons.length) {
              const { pkg, addons } = extractPackageInfo(existingDeal.properties)
              if (!formPackage) formPackage = pkg
              if (!formAddons.length) formAddons = addons
            }
            // Capture add-on Catalogue IDs from Deal.Add-ons relation
            addonCatalogueIds = (existingDeal.properties["Add-ons"]?.relation || []).map(r => r.id.replace(/-/g, ""))
          } catch (e) {
            console.warn("[deposit_paid] existing deal advance:", e.message)
          }
          console.log(`[deposit_paid] lead has existing deal → advancing to Building: ${dealId}`)

          // Ensure Lead is marked Converted
          const leadStage = lp.Stage?.status?.name || ""
          if (leadStage !== "Converted") {
            await patchPage(leadId, { "Stage": { status: { name: "Converted" } } }, token).catch(() => {})
          }
          // Link Quotation back to Deal on Quotation side
          if (quotationId) {
            await patchPage(quotationId, { "Deal Source": { relation: [{ id: dealId }] } }, token).catch(() => {})
          }
          // Re-point Invoice Deal Source to the Deal
          await patchPage(pageId, { "Deal Source": { relation: [{ id: dealId }] } }, token).catch(() => {})

        } else {
          // No existing Deal — create a new one at Building
          const dealPage = await createPage({
            parent: { database_id: DB.DEALS },
            properties: {
              "Lead Name":   { title: [{ text: { content: leadName } }] },
              "Stage":       { status: { name: "Closed-Won" } },
              "Client Type": { select: { name: "New Client" } },
              "Lead Source": { relation: [{ id: leadId }] },
              ...(compIds.length       ? { "Company":       { relation: [{ id: compIds[0] }] } } : {}),
              ...(picIds.length        ? { "Primary Contact": { relation: [{ id: picIds[0] }] } } : {}),
              ...(osInterest           ? { "Package Type":  { select:   { name: osInterest } } } : {}),
              ...(addons.length        ? { "Add-ons":       { multi_select: addons } } : {}),
              ...(quotationAmount      ? { "Deal Value":    { number: quotationAmount } } : {}),
              ...(quotationId          ? { "Quotation":     { relation: [{ id: quotationId }] } } : {}),
              ...(pageId               ? { "Invoices":      { relation: [{ id: pageId }] } } : {}),
              ...(situation            ? { "Situation":     { rich_text: [{ text: { content: situation } }] } } : {}),
              ...(notes                ? { "Notes":         { rich_text: [{ text: { content: notes } }] } } : {}),
              ...(discoveryCall        ? { "Discovery Call":{ date: { start: discoveryCall } } } : {}),
            },
          }, token)
          dealId = dealPage.id.replace(/-/g, "")
          console.log(`[deposit_paid] lead converted → new deal: ${dealId}`)

          // Mark Lead as Converted + link Deal
          await patchPage(leadId, {
            "Stage": { status: { name: "Converted" } },
            "Deal":  { relation: [{ id: dealId }] },
          }, token)

          // Link Quotation's Deal Source → new Deal
          if (quotationId) {
            await patchPage(quotationId, { "Deal Source": { relation: [{ id: dealId }] } }, token).catch(() => {})
          }
          // Re-point Invoice Deal Source to the new Deal
          await patchPage(pageId, { "Deal Source": { relation: [{ id: dealId }] } }, token).catch(() => {})
        }

      } else {
        // ── Existing client: Deal → Building ─────────────────────────────────
        dealId = leadId
        const currentStage = sourcePage.properties.Stage?.status?.name || ""
        const doneStages   = ["Closed-Won", "Closed-Lost"]
        if (!doneStages.includes(currentStage)) {
          await patchPage(dealId, { "Stage": { status: { name: "Closed-Won" } } }, token)
          console.log(`[deposit_paid] deal stage → Building: ${dealId}`)
        }

        // Capture for onboarding form URL
        ;({ pkg: formPackage, addons: formAddons } = extractPackageInfo(sourcePage.properties))
        // Fallback: Deal uses OS Type relation — extractPackageInfo can't read it.
        // Use Quotation package names (already fetched above) if still empty.
        if (!formPackage && quotationPackageNames.length) {
          formPackage = quotationPackageNames.find(n => OS_NAMES.has(n)) || quotationPackageNames[0] || ""
        }
      }
    } catch (e) {
      console.warn("[deposit_paid] stage advance:", e.message)
    }
  }

  // ── Fetch Add-ons Catalogue IDs from Deal (all paths) ────────────────────
  // addonCatalogueIds may already be set if we went through the existingDeal path.
  // For all other paths, read Deal.Add-ons relation now that dealId is resolved.
  if (!addonCatalogueIds.length && dealId) {
    try {
      const dp = await getPage(dealId, token)
      addonCatalogueIds = (dp.properties["Add-ons"]?.relation || []).map(r => r.id.replace(/-/g, ""))
    } catch (e) {
      console.warn("[deposit_paid] fetch deal add-ons:", e.message)
    }
  }

  // ── Resolve company name EARLY (needed for onboarding form URL) ─────────
  let companyName = ""
  if (companyId) {
    try {
      const cp = await getPage(companyId, token)
      for (const v of Object.values(cp.properties)) {
        if (v.type === "title") { companyName = plain(v.title); break }
      }
    } catch {}
  }

  // ── Build onboarding form URL and save to Deal BEFORE heavy project work ──
  // This runs early to avoid Vercel timeout (10s Hobby plan) cutting it off.
  // Form lives at /onboarding and uses these params to conditionally show/hide steps:
  //   client=  — company name (pre-fills sidebar label)
  //   package= — OS package e.g. "Business OS", "Revenue OS" (controls which OS steps appear)
  //   addons=  — comma-separated add-on names (controls Add-ons step content)
  //   deal=    — Notion Deal page ID (linked on form submission)
  const onboardingParams = new URLSearchParams()
  if (companyName)       onboardingParams.set("client",  companyName)
  if (formPackage)       onboardingParams.set("package", formPackage)
  if (formAddons.length) onboardingParams.set("addons",  formAddons.join(","))
  if (dealId)            onboardingParams.set("deal",    dealId)
  const formUrl  = `https://opxio.io/onboarding?${onboardingParams.toString()}`
  const picPhone = companyId ? await getPicPhone(companyId, token) : ""
  const waUrl    = buildWaUrl(picPhone, companyName || "there", formUrl)

  // Save form URL + WA link to Deal page
  if (dealId) {
    await patchPage(dealId, {
      "Onboarding Form": { url: formUrl },
      ...(waUrl ? { "WA Link": { url: waUrl } } : {}),
    }, token).catch(e => console.warn("[deposit_paid] deal form link:", e.message))
  }

  // ── Find or create Project ────────────────────────────────────────────────
  // Project is created HERE at deposit paid — not at invoice creation.
  // Primary: Invoice.Project direct link (set if this is an add-on flow).
  // Otherwise create fresh.
  let projectId = props["Client Build"]?.relation?.[0]?.id?.replace(/-/g, "") || null
  let phasesCount = 0, tasksCount = 0

  // Fallback queries for edge cases (e.g. manually created invoices)
  if (!projectId && quotationId) {
    try {
      const rows = await queryDB(DB.PROJECTS, { property: "Quotation", relation: { contains: quotationId } }, token)
      if (rows.length) projectId = rows[0].id.replace(/-/g, "")
    } catch {}
  }
  if (!projectId && dealId) {
    try {
      const rows = await queryDB(DB.PROJECTS, { property: "Deals", relation: { contains: dealId } }, token)
      if (rows.length) projectId = rows[0].id.replace(/-/g, "")
    } catch {}
  }
  if (!projectId && companyId) {
    try {
      const rows = await queryDB(DB.PROJECTS, { property: "Company", relation: { contains: companyId } }, token)
      if (rows.length) projectId = rows[0].id.replace(/-/g, "")
    } catch {}
  }

  // Create the project if still not found
  if (!projectId) {
    try {
      const projectName = companyName
        ? `${companyName} — ${formPackage || "OS"} Build`
        : `${formPackage || "OS"} Build`
      const projPage = await createPage({
        parent: { database_id: DB.PROJECTS },
        properties: {
          "Project Name": { title: [{ text: { content: projectName } }] },
          "Status":       { status: { name: "Awaiting Build" } },
          ...(quotationId ? { "Quotation": { relation: [{ id: quotationId }] } } : {}),
          ...(pageId      ? { "Invoice":   { relation: [{ id: pageId }] } } : {}),
          ...(companyId   ? { "Company":   { relation: [{ id: companyId }] } } : {}),
          ...(dealId      ? { "Deals":     { relation: [{ id: dealId }] } } : {}),
          ...(picId       ? { "Primary Contact": { relation: [{ id: picId }] } } : {}),
        },
      }, token)
      projectId = projPage.id.replace(/-/g, "")
      // Link Invoice → Project for future lookups
      await patchPage(pageId, { "Client Build": { relation: [{ id: projectId }] } }, token).catch(() => {})
      console.log("[deposit_paid] Created project:", projectId)
    } catch (e) {
      console.warn("[deposit_paid] project creation failed:", e.message)
    }
  }

  console.log("[deposit_paid] projectId:", projectId || "NOT FOUND")

  // ── Create Client Account record FIRST ────────────────────────────────────
  // Must happen before triggerSetupProject so setup_project can read OS Installed
  // from the linked Client Account to determine which phases/tasks to generate.
  const packages = ["Base OS"]
  if (formPackage) packages.push(formPackage)
  formAddons.forEach(a => packages.push(a))

  const clientAccountId = await createClientAccount({
    invoiceId: pageId,
    companyId,
    companyName,
    dealId,
    leadId,
    picId,
    projectId,
    packages,
    packageCatalogueIds,
    addonCatalogueIds,
    formUrl,
    clientOrigin,
    today,
    token,
  })

  // ── Map formPackage + formAddons → OS Scope multi_select ──────────────────
  // setup_project reads OS Scope from the Project record to determine which
  // phases and tasks to generate. Must be written before triggerSetupProject fires.
  const PACKAGE_TO_SCOPE = {
    "Revenue OS":    ["Revenue OS"],
    "Operations OS": ["Operations OS"],
    "Marketing OS":  ["Marketing OS"],
    "Finance OS":    ["Finance OS"],
    "Team OS":       ["Team OS"],
    "Retention OS":  ["Retention OS"],
    "Business OS":   ["Revenue OS", "Operations OS"],
    "Dual":          ["Revenue OS", "Operations OS"],
    "Pro":           ["Revenue OS", "Operations OS", "Finance OS"],
    "Full Stack":    ["Revenue OS", "Operations OS", "Marketing OS", "Finance OS"],
    "Starter":       ["Revenue OS"],
    "Micro Install — 1 Module": ["Revenue OS"],
    "Micro Install — 2 Modules": ["Revenue OS"],
    "Micro Install — 3 Modules": ["Revenue OS"],
  }
  const ADDON_TO_SCOPE = {
    "Enhanced Dashboard": "Enhanced Dashboard",
    "Custom Widget":      "Custom Widget",
    "Automations":        "Automations",
    "API & Webhook Automations": "Automations",
    "Team OS":            "Team OS",
    "Retention OS":       "Retention OS",
    "Sales OS":           "Revenue OS",
  }

  const osScopeSet = new Set(PACKAGE_TO_SCOPE[formPackage] || [])
  // When formPackage is empty, derive scope from Quotation's Catalogue package names
  if (!osScopeSet.size && quotationPackageNames.length) {
    quotationPackageNames.forEach(name => {
      ;(PACKAGE_TO_SCOPE[name] || []).forEach(s => osScopeSet.add(s))
    })
  }
  // Final fallback if still empty
  if (!osScopeSet.size) osScopeSet.add("Revenue OS")
  formAddons.forEach(a => { if (ADDON_TO_SCOPE[a]) osScopeSet.add(ADDON_TO_SCOPE[a]) })
  const osScope = [...osScopeSet].map(s => ({ name: s }))

  // ── Project setup ──────────────────────────────────────────────────────────
  if (projectId) {
    await patchPage(projectId, {
      "Status":          { status: { name: "Build Started" } },
      "Start Date":      { date: { start: today } },
      "Onboarding Form": { url: formUrl },
      "OS Scope":        { multi_select: osScope },
      ...(dealId && dealId !== leadId ? { "Deals": { relation: [{ id: dealId }] } } : {}),
      ...(addonCatalogueIds.length ? { "Add-Ons": { relation: addonCatalogueIds.map(id => ({ id })) } } : {}),
    }, token)
    // Fire setup_project non-blocking via waitUntil — avoids Vercel timeout.
    // Phases and tasks are created after the response is sent.
    waitUntil(triggerSetupProject(projectId, packages).then(([p, t]) => {
      console.log(`[deposit_paid] setup_project done: ${p} phases, ${t} tasks`)
    }))
    // phasesCount / tasksCount remain 0 in the response (setup runs async)
  }

  // ── Finance Ledger — auto-create Deposit entry ───────────────────────────
  const depositAmt = props["Deposit (50%)"]?.number || props["Amount"]?.number || props["Amount (MYR)"]?.number || 0
  createLedgerEntry({
    title:     companyName ? `Deposit — ${companyName}` : "Client Deposit",
    amount:    depositAmt,
    category:  "Client Deposit",
    source:    "Client Payment",
    payment:   "Bank Transfer",
    status:    "Received",
    date:      today,
    invoiceId: pageId,
    projectId: projectId || null,
    notes:     "Auto-created when deposit marked received",
  }, token).catch(() => {})

  // ── Create Supabase portal record + send activation email ─────────────────
  // Runs after all Notion work is done — non-blocking, failure doesn't break flow
  let portalToken = null
  let portalSlug  = null
  try {
    // Get PIC email for portal activation email
    let contactEmail = ""
    let firstName    = ""
    if (picId) {
      try {
        const picPage = await getPage(picId, token)
        for (const [, prop] of Object.entries(picPage.properties)) {
          if (prop.type === "email" && prop.email) { contactEmail = prop.email; break }
        }
        firstName = plain(picPage.properties["First Name"]?.rich_text || []) ||
                    plain(picPage.properties.Name?.title || []).split(" ")[0] || ""
      } catch {}
    }

    const portalResult = await createPortalClient({
      companyName:   companyName,
      projectId:     projectId,
      contactEmail:  contactEmail,
      packages:      packages,
    })

    if (portalResult) {
      portalToken = portalResult.portalToken
      portalSlug  = portalResult.slug
      await sendPortalEmail({ email: contactEmail, firstName, companyName, portalToken })
    }
  } catch (e) {
    console.warn("[deposit_paid] portal setup:", e.message)
  }

  // ── Auto-create Team Task — kick off build ────────────────────────────────
  await createTeamTask({
    taskName:  `Kick off build — ${companyName || "New Client"}`,
    category:  "Client",
    priority:  "High",
    projectId: projectId  || undefined,
    dealId:    dealId     || undefined,
    leadId:    leadId     || undefined,
    companyId: companyId  || undefined,
    accountId: clientAccountId || undefined,
  })

  return {
    status:            "success",
    invoice_id:        pageId,
    lead_id:           leadId,
    deal_id:           dealId,
    project_id:        projectId,
    client_account_id: clientAccountId,
    company_id:        companyId,
    form_url:          formUrl,
    wa_url:            waUrl || null,
    form_package:      formPackage,
    form_addons:       formAddons,
    packages,
    phases_created:    phasesCount,
    tasks_created:     tasksCount,
    portal_token:      portalToken,
    portal_slug:       portalSlug,
  }
}

export async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Deposit Paid", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })
  try {
    const result = await run(req.body || {})
    return res.json(result)
  } catch (e) {
    console.error("[deposit_paid]", e)
    return res.status(500).json({ error: e.message })
  }
}