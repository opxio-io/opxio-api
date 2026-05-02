// ─── expansion_install.js ─────────────────────────────────────────────────
// POST /api/expansion_install   { "page_id": "<expansion_record_page_id>" }
// Triggered by Notion button "Start Expansion Build" on Expansions DB record.
//
// Called AFTER the expansion invoice deposit has been received.
//
// Flow:
//   1. Read Expansion record → Company, OS Scope, Client Account, linked Invoice
//   2. Create a lean Client Build (Expansion type — no infra/foundation phases)
//   3. Call setup_project with mode=expansion and the new OS scope
//   4. Update Client Account → append OS Installed + link new Client Build
//   5. Update Expansion record → Status: In Progress + Client Build relation

import { getPage, patchPage, createPage, queryDB, plain, DB, createTeamTask } from "../../lib/notion"

const API_URL = "https://api.opxio.io"

// Valid OS names that map to setup_project scope keys
const KNOWN_OS = new Set([
  "Revenue OS",
  "Operations OS",
  "Marketing OS",
  "Finance OS",
  "Team OS",
  "Retention OS",
  "Sales OS",
])

// ─── Look up Catalogue IDs for given OS names ─────────────────────────────
// Queries Catalogue DB and matches by title. Resilient — returns [] on any error.
async function findCatalogueIds(osNames, token) {
  try {
    const allItems = await queryDB(DB.CATALOGUE, undefined, token)
    const ids = []
    for (const osName of osNames) {
      const match = allItems.find(item => {
        for (const v of Object.values(item.properties)) {
          if (v.type === "title") {
            const name = plain(v.title)
            return name === osName || name.includes(osName)
          }
        }
        return false
      })
      if (match) {
        ids.push(match.id.replace(/-/g, ""))
      } else {
        console.warn(`[expansion_install] Catalogue item not found for: ${osName}`)
      }
    }
    return ids
  } catch (e) {
    console.warn("[expansion_install] catalogue lookup failed (non-fatal):", e.message)
    return []
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function run(payload) {
  const token = process.env.NOTION_API_KEY
  const rawId = payload.page_id
    || payload.data?.id
    || payload.data?.page_id
    || payload.source?.page_id
    || payload.source?.id
  if (!rawId) throw new Error("No page_id in payload")
  const expansionId = rawId.replace(/-/g, "")

  const exp   = await getPage(expansionId, token)
  const props = exp.properties

  const expName   = plain(props.Name?.title || [])
  const expStatus = props.Status?.select?.name || ""

  // Guard: don't build if already started
  const doneStatuses = ["In Progress", "Build Complete", "Closed – Paid"]
  if (doneStatuses.includes(expStatus)) {
    throw new Error(`Expansion build already active (status: ${expStatus})`)
  }

  // ── Resolve IDs from Expansion record ─────────────────────────────────────
  const companyId = props.Company?.relation?.[0]?.id?.replace(/-/g, "") || null

  const clientAccountId = props["Client Account"]?.relation?.[0]?.id?.replace(/-/g, "") || null

  // Invoice: linked to expansion record
  const invoiceId = props.Invoice?.relation?.[0]?.id?.replace(/-/g, "") || null

  // ── Resolve new OS scope ───────────────────────────────────────────────────
  // Priority 1: "OS Scope" multi_select
  // Priority 2: Parse from "Type" select (e.g. "Operations OS Expansion" or "Operations OS")
  // Priority 3: Parse from expansion Name
  let newOsScope = (props["OS Scope"]?.multi_select || []).map(s => s.name).filter(n => KNOWN_OS.has(n))

  if (!newOsScope.length) {
    const typeName = props.Type?.select?.name || ""
    const matched  = [...KNOWN_OS].find(os => typeName.includes(os))
    if (matched) newOsScope = [matched]
  }

  if (!newOsScope.length) {
    const matched = [...KNOWN_OS].find(os => expName.includes(os))
    if (matched) newOsScope = [matched]
  }

  if (!newOsScope.length) {
    throw new Error(
      `Cannot determine OS scope for expansion "${expName}". ` +
      `Add "OS Scope" multi_select field to Expansions DB, or include the OS name in the Type or Name field.`
    )
  }

  console.log(`[expansion_install] Expansion: ${expName} | New OS: ${newOsScope.join(", ")}`)

  // ── Resolve company name ───────────────────────────────────────────────────
  let companyName = ""
  if (companyId) {
    try {
      const cp = await getPage(companyId, token)
      for (const v of Object.values(cp.properties)) {
        if (v.type === "title") { companyName = plain(v.title); break }
      }
    } catch (e) {
      console.warn("[expansion_install] company name lookup:", e.message)
    }
  }

  const today   = new Date().toISOString().split("T")[0]
  const osSuffix = newOsScope.join(" + ")
  const buildName = companyName
    ? `${companyName} — ${osSuffix} Expansion Build`
    : `${osSuffix} Expansion Build`

  // ── Create lean Client Build ───────────────────────────────────────────────
  // No Pre-Build / Infrastructure / Foundation phases — those belong to the initial build.
  // setup_project in expansion mode handles this automatically.
  const buildProps = {
    "Project Name": { title: [{ text: { content: buildName } }] },
    "Status":       { status: { name: "Build Started" } },
    "Start Date":   { date: { start: today } },
    "OS Scope":     { multi_select: newOsScope.map(s => ({ name: s })) },
    ...(companyId       ? { "Company":        { relation: [{ id: companyId }] } } : {}),
    ...(clientAccountId ? { "Client Account": { relation: [{ id: clientAccountId }] } } : {}),
    ...(invoiceId       ? { "Invoice":        { relation: [{ id: invoiceId }] } } : {}),
  }

  // Attempt to set "Build Type" select — non-critical, skip if property doesn't exist
  let buildPage
  try {
    buildPage = await createPage({
      parent:     { database_id: DB.PROJECTS },
      properties: { ...buildProps, "Build Type": { select: { name: "Expansion" } } },
    }, token)
  } catch {
    buildPage = await createPage({
      parent:     { database_id: DB.PROJECTS },
      properties: buildProps,
    }, token)
  }

  const buildId = buildPage.id.replace(/-/g, "")
  console.log("[expansion_install] Client Build created:", buildId, "→", buildName)

  // ── Call setup_project in expansion mode ──────────────────────────────────
  // Skips Pre-Build, Infrastructure, Foundation phases.
  // Creates only: OS build phase(s) + Expansion QC + Expansion Handover.
  let phasesCreated = 0
  let tasksCreated  = 0
  try {
    const r = await fetch(`${API_URL}/api/setup_project`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        page_id:  buildId,
        packages: newOsScope,
        mode:     "expansion",
      }),
    })
    if (r.ok) {
      const d    = await r.json()
      phasesCreated = d.phases_created || 0
      tasksCreated  = d.tasks_created  || 0
      console.log(`[expansion_install] setup_project: ${phasesCreated} phases, ${tasksCreated} tasks`)
    } else {
      const errText = await r.text().catch(() => "")
      console.warn("[expansion_install] setup_project non-ok:", r.status, errText)
    }
  } catch (e) {
    console.warn("[expansion_install] setup_project call failed:", e.message)
  }

  // ── Update Client Account ──────────────────────────────────────────────────
  // Append: OS Installed (Catalogue relation) + Project Tracker (Client Builds relation)
  if (clientAccountId) {
    try {
      const ca      = await getPage(clientAccountId, token)
      const caProps = ca.properties

      // Existing OS Installed Catalogue IDs
      const existingOsIds = (caProps["OS Installed"]?.relation || []).map(r => r.id.replace(/-/g, ""))

      // Look up new Catalogue IDs for the new OS
      const newCatalogueIds = await findCatalogueIds(newOsScope, token)

      // Merge — deduplicate
      const allOsIds = [...new Set([...existingOsIds, ...newCatalogueIds])]

      // Existing Client Build IDs (Project Tracker field)
      const existingBuildIds = (
        caProps["Project Tracker"]?.relation ||
        caProps["Client Builds"]?.relation   ||
        []
      ).map(r => r.id.replace(/-/g, ""))
      const allBuildIds = [...new Set([...existingBuildIds, buildId])]

      await patchPage(clientAccountId, {
        ...(allOsIds.length    ? { "OS Installed":   { relation: allOsIds.map(id => ({ id })) } } : {}),
        ...(allBuildIds.length ? { "Project Tracker": { relation: allBuildIds.map(id => ({ id })) } } : {}),
      }, token)

      console.log(
        `[expansion_install] Client Account ${clientAccountId} updated`,
        `| OS Installed: ${allOsIds.length} | Builds: ${allBuildIds.length}`
      )
    } catch (e) {
      console.warn("[expansion_install] Client Account update failed:", e.message)
    }
  } else {
    console.warn("[expansion_install] No Client Account ID — skipping Client Account update")
  }

  // ── Update Expansion record ────────────────────────────────────────────────
  // Status → In Progress + link the new Client Build
  const expansionUpdates = {
    "Status": { select: { name: "In Progress" } },
  }

  // Link Client Build back to Expansion record
  try {
    await patchPage(expansionId, {
      ...expansionUpdates,
      "Client Build": { relation: [{ id: buildId }] },
    }, token)
  } catch {
    // Client Build field doesn't exist yet — update Status only
    try {
      await patchPage(expansionId, expansionUpdates, token)
    } catch (e2) {
      console.warn("[expansion_install] expansion record update failed:", e2.message)
    }
  }

  // ── Auto-create Team Task ──────────────────────────────────────────────────
  await createTeamTask({
    taskName:  `Kick off expansion build — ${companyName || expName} (${osSuffix})`,
    category:  "Client",
    priority:  "High",
    projectId: buildId,
    companyId: companyId  || undefined,
    accountId: clientAccountId || undefined,
    invoiceId: invoiceId  || undefined,
  })

  return {
    status:            "success",
    expansion_id:      expansionId,
    expansion_name:    expName,
    build_id:          buildId,
    build_name:        buildName,
    os_scope:          newOsScope,
    client_account_id: clientAccountId,
    company_name:      companyName,
    phases_created:    phasesCreated,
    tasks_created:     tasksCreated,
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────
export async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization")
    return res.status(200).end()
  }
  if (req.method === "GET") {
    return res.json({ service: "Opxio — Expansion Install", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  try {
    const result = await run(req.body || {})
    return res.json(result)
  } catch (e) {
    console.error("[expansion_install]", e)
    return res.status(500).json({ error: e.message })
  }
}