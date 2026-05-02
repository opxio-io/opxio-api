// ─── setup_project.js ──────────────────────────────────────────────────────
// POST /api/setup_project   { "page_id": "<project_page_id>" }
// Called by deposit_paid.js after deposit is confirmed.
//
// Architecture (JSON config driven):
//   1. Reads Project → OS Scope (multi_select) to determine what's in scope
//   2. Reads config/tasks.json — the single source of truth for all phases + tasks
//   3. Filters phases and tasks based on scope
//   4. Resolves dependency ordering for multi-OS installs
//   5. Creates Phase records in Project Phases DB (DB.PHASES)
//   6. Creates Task records in Project Tasks DB (DB.TASKS) linked to phases
//   7. Links phases to Project, sets first phase to In Progress
//
// To edit tasks: update config/tasks.json — no Notion DB changes needed.

import { getPage, patchPage, createPage, plain, queryDB, DB } from "../lib/notion.js"
import taskConfig from "../config/tasks.json" with { type: "json" }

// ─── Scope key mapping ───────────────────────────────────────────────────────
// Maps Notion "OS Scope" multi_select values → internal scope keys in tasks.json
const SCOPE_MAP = {
  "Revenue OS":         "revenue_os",
  "Operations OS":      "operations_os",
  "Marketing OS":       "marketing_os",
  "Finance OS":         "finance_os",
  "Team OS":            "team_os",
  "Retention OS":       "retention_os",
  "Enhanced Dashboard": "enhanced_dashboard",
  "Automations":        "automations",
  "Custom Widget":      "custom_widget",
}

// Dependency resolution order — when a phase has a dependency, this defines
// which OS must complete before it can start
const DEPENDENCY_ORDER = [
  "revenue_os",
  "operations_os",
  "finance_os",
  "retention_os",
  "team_os",
  "marketing_os",
]

// ─── Date helpers ────────────────────────────────────────────────────────────
const TIMELINE_DAYS = {
  "Under 2 weeks": 14,
  "2–4 weeks":     28,
  "1–3 months":    75,
  "3+ months":     105,
}

function addDays(iso, days) {
  const d = new Date(iso)
  d.setDate(d.getDate() + days)
  return d.toISOString().split("T")[0]
}

// ─── Resolve which phases apply to this project scope ───────────────────────
// mode = "normal" (default) | "expansion"
//   normal:    all-scope phases (Pre-Build, Infra, Foundation, QC, Handover) + matching OS phases
//   expansion: skip all-scope foundation phases, include OS phases + expansion-specific QC/Handover
function resolvePhasesForScope(scope, mode = "normal") {
  const phases = []

  for (const phase of taskConfig.phases) {
    const phaseScope = phase.scope

    if (mode === "expansion") {
      // Expansion mode:
      //   ✓ expansion-scope phases (lightweight QC + Handover)
      //   ✓ OS-specific phases matching scope (the new OS being installed)
      //   ✗ "all"-scope phases (Pre-Build, Infrastructure, Foundation, full QC, full Handover)
      if (phaseScope.includes("expansion")) {
        phases.push({ ...phase })
        continue
      }
      if (phaseScope.includes("all")) continue
      const match = phaseScope.some(s => scope.includes(s))
      if (match) phases.push({ ...phase })

    } else {
      // Normal mode:
      //   ✓ "all"-scope phases (Pre-Build, Infrastructure, Foundation, QC, Handover)
      //   ✓ OS-specific phases matching scope
      //   ✗ "expansion"-scope phases (these are expansion-only)
      if (phaseScope.includes("expansion")) continue
      if (phaseScope.includes("all")) {
        phases.push({ ...phase })
        continue
      }
      const match = phaseScope.some(s => scope.includes(s))
      if (match) phases.push({ ...phase })
    }
  }

  // Sort: first by phase_no, then by dependency order within same phase_no
  phases.sort((a, b) => {
    if (a.phase_no !== b.phase_no) return a.phase_no - b.phase_no
    const aIdx = DEPENDENCY_ORDER.indexOf(a.scope[0])
    const bIdx = DEPENDENCY_ORDER.indexOf(b.scope[0])
    if (aIdx === -1) return 1
    if (bIdx === -1) return -1
    return aIdx - bIdx
  })

  return phases
}

// ─── Renumber phases sequentially when multiple OS share the same phase_no ──
// e.g. Revenue OS (3) + Operations OS (3) → Phase 3, Phase 4
// "all" scope phases that come after get bumped accordingly.
function renumberPhases(phases) {
  let current = -1
  return phases.map((phase, i) => {
    if (i === 0) {
      current = phase.phase_no
    } else {
      const prev = phases[i - 1].phase_no
      if (phase.phase_no === prev) {
        // Same base number — increment
        current++
      } else {
        // New base number — jump forward but never go backward
        current = Math.max(current + 1, phase.phase_no)
      }
    }
    return { ...phase, phase_no: current }
  })
}

// ─── MAIN SETUP ──────────────────────────────────────────────────────────────
async function setup(payload) {
  const token   = process.env.NOTION_API_KEY
  const rawId   = payload.page_id || payload.data?.id || payload.data?.page_id || payload.source?.page_id || payload.source?.id
  if (!rawId) throw new Error("No page_id in payload")
  const projectId = rawId.replace(/-/g, "")

  const project = await getPage(projectId, token)
  const props   = project.properties

  // ── Resolve OS scope ──────────────────────────────────────────────────────
  // Priority 1: packages array passed directly from deposit_paid (most reliable)
  // Priority 2: OS Scope multi_select on the Project page (manual override)
  // Priority 3: infer from Package select (legacy fallback)
  let rawScope = []

  const payloadPackages = (payload.packages || []).filter(p => p !== "Base OS")
  if (payloadPackages.length) {
    rawScope = payloadPackages
    console.log(`[setup_project] OS scope from payload: ${rawScope.join(", ")}`)
  }

  if (!rawScope.length) {
    rawScope = (props["OS Scope"]?.multi_select || []).map(s => s.name)
    if (rawScope.length) console.log(`[setup_project] OS scope from Project.OS Scope: ${rawScope.join(", ")}`)
  }

  if (!rawScope.length) {
    const pkg = props.Package?.select?.name || ""
    if (pkg) {
      if (pkg.includes("Revenue"))    rawScope.push("Revenue OS")
      if (pkg.includes("Operations")) rawScope.push("Operations OS")
      if (pkg.includes("Marketing"))  rawScope.push("Marketing OS")
      if (pkg.includes("Finance"))    rawScope.push("Finance OS")
      if (pkg.includes("Business"))   { rawScope.push("Revenue OS"); rawScope.push("Operations OS") }
    }
  }

  if (!rawScope.length) {
    console.warn(`[setup_project] No scope detected — using Revenue OS as default`)
    rawScope.push("Revenue OS")
  }

  const scope = rawScope.map(s => SCOPE_MAP[s]).filter(Boolean)

  console.log(`[setup_project] Project ${projectId} | Scope: ${scope.join(", ")}`)

  const today     = new Date().toISOString().split("T")[0]
  const startDate = props["Start Date"]?.date?.start || today

  // ── Derive totalDays from Catalogue Build Days (summed across OS packages in scope) ──
  let totalDays = TIMELINE_DAYS["2–4 weeks"]  // fallback: 28 days
  try {
    const catalogueRows = await queryDB(DB.CATALOGUE, {
      and: [
        { property: "Tier",   select: { equals: "OS Package" } },
        { property: "Status", select: { equals: "Active" } },
      ]
    }, process.env.NOTION_API_KEY)
    const osNameSet  = new Set(rawScope)
    const matched    = catalogueRows.filter(r =>
      osNameSet.has(plain(r.properties["Product Name"]?.title || []))
    )
    const sumDays    = matched.reduce((acc, r) => acc + (r.properties["Build Days"]?.number || 0), 0)
    if (sumDays > 0) totalDays = sumDays
    console.log(`[setup_project] Catalogue Build Days: ${sumDays}d across [${matched.map(r => plain(r.properties["Product Name"]?.title || [])).join(", ")}] → totalDays: ${totalDays}`)
  } catch (e) {
    console.warn("[setup_project] Build Days Catalogue lookup failed — using default:", e.message)
  }

  const targetDate = addDays(startDate, totalDays)

  // ── Smart guard: detect which OS types are already covered ───────────────
  // Skips individual phases already built rather than blanket-blocking the run.
  // This allows expansion installs (adding Operations OS to existing Revenue OS build)
  // to append the new phase without duplicating shared phases (0, 1, 2, QC, Close).
  const existingPhaseIds = (props.Phases?.relation || []).map(r => r.id.replace(/-/g, ""))
  const coveredOsTypes  = new Set()  // e.g. "Revenue OS", "Operations OS"
  const coveredAllNos   = new Set()  // phase_no values already present for "all"-scope phases
  let   maxExistingOsNo = 0  // highest phase_no among OS-specific phases only (not QC/Close)

  if (existingPhaseIds.length > 0) {
    const existingData = await Promise.all(
      existingPhaseIds.slice(0, 30).map(async id => {
        try {
          const p = await getPage(id, token)
          return {
            osType:  p.properties["OS Type"]?.select?.name  || null,
            phaseNo: p.properties["Phase No."]?.number      ?? null,
          }
        } catch { return null }
      })
    )
    for (const ep of existingData.filter(Boolean)) {
      if (ep.osType && !["All", "Base OS", null].includes(ep.osType)) {
        coveredOsTypes.add(ep.osType)
        if (ep.phaseNo != null && ep.phaseNo > maxExistingOsNo) maxExistingOsNo = ep.phaseNo
      } else if (ep.phaseNo != null) {
        coveredAllNos.add(ep.phaseNo)
      }
    }
    console.log(`[setup_project] Covered OS types: ${[...coveredOsTypes].join(", ") || "none"} | max OS phase: ${maxExistingOsNo}`)
  }

  // ── Resolve phases from config ────────────────────────────────────────────
  // mode "expansion" → skip foundation phases, use lightweight QC/Handover
  const mode        = payload.mode || "normal"
  if (mode === "expansion") console.log(`[setup_project] Mode: expansion — skipping Pre-Build, Infrastructure, Foundation phases`)
  const allResolved = resolvePhasesForScope(scope, mode)
  const renumbered  = renumberPhases(allResolved)

  // Filter out phases already built — skip "all"-scope phases that exist,
  // and skip OS-specific phases whose OS type is already covered.
  const phases = renumbered.filter(phase => {
    if (phase.scope.includes("all")) return !coveredAllNos.has(phase.phase_no)
    return !coveredOsTypes.has(phase.os_type)
  })

  // For expansion installs: bump new OS phase numbers above the highest existing
  // OS-specific phase. Uses maxExistingOsNo — NOT the overall max — so QC and
  // Handover phases (which are "all" scope and already skipped above) don't
  // push the new OS phase to the wrong number.
  // e.g. existing Revenue OS = phase 3 → new Operations OS gets phase 4, not 7.
  if (maxExistingOsNo > 0) {
    const newOsPhases = phases.filter(p => !p.scope.includes("all"))
    if (newOsPhases.length > 0) {
      const minNew = newOsPhases[0].phase_no
      if (minNew <= maxExistingOsNo) {
        const bump = maxExistingOsNo + 1 - minNew
        phases.forEach((p, i) => {
          if (!p.scope.includes("all")) phases[i] = { ...p, phase_no: p.phase_no + bump }
        })
      }
    }
  }

  if (phases.length === 0) {
    console.log(`[setup_project] All phases already exist — skipping`)
    return { status: "skipped", reason: "all phases already exist", project_id: projectId }
  }

  console.log(`[setup_project] Resolved ${phases.length} phases to create (${allResolved.length} total for scope)`)

  // ── Create phase records ──────────────────────────────────────────────────
  const PHASE_ICON = { type: "icon", icon: { name: "map-pin", color: "red" } }
  const TASK_ICON  = { type: "icon", icon: { name: "map-pin", color: "red" } }

  const totalPhases = phases.length
  const createdPhases = []

  for (let idx = 0; idx < phases.length; idx++) {
    const phase    = phases[idx]
    const phStart  = addDays(startDate, Math.round(totalDays * (idx / totalPhases)))
    const phEnd    = addDays(startDate, Math.round(totalDays * ((idx + 1) / totalPhases)))

    const phasePage = await createPage({
      parent: { database_id: DB.PHASES },
      icon: PHASE_ICON,
      properties: {
        "Phase Name":  { title: [{ text: { content: `Phase ${phase.phase_no} — ${phase.name}` } }] },
        "Phase No.":   { number: phase.phase_no },
        "Phase Type":  { select: { name: phase.phase_type } },
        "OS Type":     { select: { name: phase.os_type } },
        "Owner":       { select: { name: phase.owner } },
        "Status":      { status: { name: "Not Started" } },
        "Start Date":  { date: { start: phStart } },
        "Due Date":    { date: { start: phEnd } },
        "Project":     { relation: [{ id: projectId }] },
      },
    }, token)

    const phaseId = phasePage.id.replace(/-/g, "")
    createdPhases.push({ phase, phaseId, phStart, phEnd })
    console.log(`[setup_project] Created phase: ${phase.name} → ${phaseId}`)
  }

  // ── Create task records in batches ────────────────────────────────────────
  const allTaskBodies = []
  let taskNo = 1

  for (const { phase, phaseId, phStart, phEnd } of createdPhases) {
    const phaseDays = Math.max(1, Math.round(
      (new Date(phEnd) - new Date(phStart)) / (1000 * 60 * 60 * 24)
    ))
    const tasks = phase.tasks || []

    for (let i = 0; i < tasks.length; i++) {
      const task        = tasks[i]
      const taskDueDate = addDays(phStart, Math.round(phaseDays * ((i + 1) / tasks.length)))

      const taskProps = {
        "Task Name":    { title: [{ text: { content: task.name } }] },
        "Task No.":     { number: taskNo++ },
        "Owner":        { select: { name: task.owner } },
        "OS Type":      { select: { name: phase.os_type } },
        "Priority":     { select: { name: task.priority || "Medium" } },
        "Status":       { status: { name: "Not Started" } },
        "Due Date":     { date: { start: taskDueDate } },
        "Project":      { relation: [{ id: projectId }] },
        "Phase":        { relation: [{ id: phaseId }] },
        "Review Round": { select: { name: task.review_round || "N/A" } },
      }

      allTaskBodies.push({
        parent: { database_id: DB.TASKS },
        icon: TASK_ICON,
        properties: taskProps,
      })
    }
  }

  // Create tasks in parallel batches of 8, collect created task IDs
  const BATCH = 8
  let tasksCreated = 0
  const createdTaskIds = []
  for (let i = 0; i < allTaskBodies.length; i += BATCH) {
    const batch = allTaskBodies.slice(i, i + BATCH)
    const pages = await Promise.all(batch.map(body => createPage(body, token)))
    pages.forEach(p => createdTaskIds.push(p.id.replace(/-/g, "")))
    tasksCreated += batch.length
  }

  // ── Link phases + tasks to project ───────────────────────────────────────
  // Tasks relation is patched in chunks of 25 (Notion API PATCH limit per call)
  const phaseIds = createdPhases.map(p => p.phaseId)

  await patchPage(projectId, {
    "Phases":               { relation: phaseIds.map(id => ({ id })) },
    "Target Handover": { date: { start: targetDate } },
  }, token)

  // Link all tasks to Project.Tasks relation in one patch
  // (Notion truncates the response to 25 but stores all IDs — has_more: true)
  await patchPage(projectId, {
    "Tasks": { relation: createdTaskIds.map(id => ({ id })) },
  }, token).catch(e => console.warn("[setup_project] link tasks to project:", e.message))

  // ── Embed progress widget on project page ─────────────────────────────────
  const widgetUrl = `https://widgets.opxio.io/operations/progress?project=${projectId}`
  try {
    await fetch(`https://api.notion.com/v1/blocks/${projectId}/children`, {
      method:  "PATCH",
      headers: {
        "Authorization":  `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
      },
      body: JSON.stringify({
        children: [
          { object: "block", type: "divider", divider: {} },
          { object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: "📊 Project Progress" } }] } },
          { object: "block", type: "embed", embed: { url: widgetUrl } },
        ],
      }),
    })
  } catch (e) {
    console.warn("[setup_project] embed widget failed (non-fatal):", e.message)
  }

  const summary = {
    status:         "success",
    project_id:     projectId,
    scope:          scope,
    phases_created: phaseIds.length,
    tasks_created:  tasksCreated,
    target_date:    targetDate,
  }

  console.log(`[setup_project] Done: ${phaseIds.length} phases, ${tasksCreated} tasks | scope: ${scope.join(", ")}`)
  return summary
}

// ─── ADVANCE TASK STATUS ─────────────────────────────────────────────────────
// POST /api/setup_project?action=advance  { "page_id": "<task_page_id>" }
// Smart single-button: Not Started → In Progress → Done
// Checks "Blocked by" relation before allowing Done.
// Also auto-advances the parent phase status.
async function advanceTask(payload) {
  const token = process.env.NOTION_API_KEY
  const rawId = payload.page_id || payload.data?.id || payload.data?.page_id || payload.source?.page_id || payload.source?.id
  if (!rawId) throw new Error("No page_id in payload")
  const taskId = rawId.replace(/-/g, "")

  const task  = await getPage(taskId, token)
  const props = task.properties
  const currentStatus = props.Status?.status?.name || "Not Started"
  const taskName      = plain(props["Task Name"]?.title || [])

  const STATUS_FLOW = {
    "Not Started": "In Progress",
    "In Progress": "Done",
    "Blocked":     "In Progress",
  }
  const nextStatus = STATUS_FLOW[currentStatus]
  if (!nextStatus) {
    return {
      status:  "no_change",
      task_id: taskId,
      task:    taskName,
      current: currentStatus,
      message: currentStatus === "Done"
        ? "Task is already complete"
        : `No automatic next step from "${currentStatus}"`,
    }
  }

  // ── Check Blocked by dependencies ─────────────────────────────────────────
  const depIds = (props["Blocked by"]?.relation || []).map(r => r.id.replace(/-/g, ""))
  if (depIds.length) {
    const deps = await Promise.all(depIds.map(id => getPage(id, token).catch(() => null)))
    const blockers = []
    for (const dep of deps) {
      if (!dep) continue
      const depStatus = dep.properties.Status?.status?.name || "Not Started"
      if (depStatus !== "Done") {
        blockers.push({ name: plain(dep.properties["Task Name"]?.title || []), status: depStatus })
      }
    }
    if (blockers.length) {
      return {
        status:   "blocked",
        task_id:  taskId,
        task:     taskName,
        current:  currentStatus,
        blockers,
        message:  `Blocked — ${blockers.length} task(s) must be completed first: ${blockers.map(b => b.name).join(", ")}`,
      }
    }
  }

  // ── Update task status + dates (Duration formula = Completed Date - Start Date) ──
  const today = new Date().toISOString().split("T")[0]
  const taskUpdates = { "Status": { status: { name: nextStatus } } }
  if (nextStatus === "In Progress") taskUpdates["Start Date"]     = { date: { start: today } }
  if (nextStatus === "Done")        taskUpdates["Completed Date"] = { date: { start: today } }
  await patchPage(taskId, taskUpdates, token)

  // ── Auto-advance parent phase status ──────────────────────────────────────
  const phaseId = (props["Phase"]?.relation || [])[0]?.id?.replace(/-/g, "")
  let phaseUpdate = null

  if (phaseId) {
    try {
      const phase    = await getPage(phaseId, token)
      const phStatus = phase.properties.Status?.status?.name || "Not Started"
      const projectId = (phase.properties.Project?.relation || [])[0]?.id?.replace(/-/g, "")

      const phaseName  = plain(phase.properties["Phase Name"]?.title || [])
      const phaseNo    = phase.properties["Phase No."]?.number ?? null

      if (nextStatus === "In Progress" && phStatus === "Not Started") {
        await patchPage(phaseId, {
          "Status":     { status: { name: "In Progress" } },
          "Start Date": { date: { start: today } },
        }, token)
        phaseUpdate = "In Progress"

        // Update project's Current Phase
        if (projectId && phaseName) {
          await patchPage(projectId, {
            "Current Phase": { select: { name: phaseName } },
          }, token).catch(e => console.warn("[advanceTask] set Current Phase:", e.message))
        }
      }

      if (nextStatus === "Done") {
        // Check if all sibling tasks in this phase are Done
        const siblingTasks = await fetch(
          `https://api.notion.com/v1/databases/${DB.TASKS}/query`,
          {
            method: "POST",
            headers: {
              "Authorization":  `Bearer ${token}`,
              "Notion-Version": "2022-06-28",
              "Content-Type":   "application/json",
            },
            body: JSON.stringify({
              filter: { property: "Phase", relation: { contains: phaseId } }
            }),
          }
        ).then(r => r.json()).catch(() => ({ results: [] }))

        const allDone = (siblingTasks.results || []).every(t =>
          t.id === taskId + "-" || // exclude current task (already marked Done above)
          t.properties?.Status?.status?.name === "Done"
        )
        if (allDone) {
          await patchPage(phaseId, {
            "Status":         { status: { name: "Done" } },
            "Completed Date": { date: { start: today } },
          }, token)
          phaseUpdate = "Done (all tasks complete)"

          // Find the next phase on the project and set it as Current Phase
          if (projectId && phaseNo !== null) {
            try {
              const proj = await getPage(projectId, token)
              const allPhaseIds = (proj.properties.Phases?.relation || []).map(r => r.id.replace(/-/g, ""))

              // Fetch all phase records to find the next one by phase_no
              const allPhases = await Promise.all(allPhaseIds.map(pid => getPage(pid, token).catch(() => null)))
              const nextPhase = allPhases
                .filter(Boolean)
                .sort((a, b) => (a.properties["Phase No."]?.number ?? 0) - (b.properties["Phase No."]?.number ?? 0))
                .find(p => (p.properties["Phase No."]?.number ?? 0) > phaseNo)

              if (nextPhase) {
                const nextPhaseName = plain(nextPhase.properties["Phase Name"]?.title || [])
                const nextPhaseId   = nextPhase.id.replace(/-/g, "")
                // Advance next phase to In Progress
                await patchPage(nextPhaseId, {
                  "Status":     { status: { name: "In Progress" } },
                  "Start Date": { date: { start: today } },
                }, token)
                // Update project Current Phase to next phase
                if (nextPhaseName) {
                  await patchPage(projectId, {
                    "Current Phase": { select: { name: nextPhaseName } },
                  }, token).catch(e => console.warn("[advanceTask] advance Current Phase:", e.message))
                }
                phaseUpdate = `Done → next phase: ${nextPhaseName}`
              } else {
                // No next phase — project is complete
                await patchPage(projectId, {
                  "Status": { status: { name: "Completed" } },
                }, token).catch(() => {})
                phaseUpdate = "Done (final phase — project complete)"
              }
            } catch (e) {
              console.warn("[advanceTask] next phase advance:", e.message)
            }
          }
        }
      }
    } catch (e) {
      console.warn("[advanceTask] phase update:", e.message)
    }
  }

  return {
    status:       "advanced",
    task_id:      taskId,
    task:         taskName,
    from:         currentStatus,
    to:           nextStatus,
    phase_update: phaseUpdate,
  }
}

// ─── AUTO-DETECT action ───────────────────────────────────────────────────────
async function detectAction(payload) {
  const token = process.env.NOTION_API_KEY
  const rawId = payload.page_id || payload.data?.id || payload.data?.page_id || payload.source?.page_id || payload.source?.id
  if (!rawId) return "setup"

  const inlineDb = (payload.data?.parent?.database_id || "").replace(/-/g, "")
  if (inlineDb === DB.TASKS.replace(/-/g, ""))    return "advance"
  if (inlineDb === DB.PROJECTS.replace(/-/g, "")) return "setup"

  try {
    const page     = await getPage(rawId.replace(/-/g, ""), token)
    const parentDb = page.parent?.database_id?.replace(/-/g, "") || ""
    if (parentDb === DB.TASKS.replace(/-/g, ""))    return "advance"
    if (parentDb === DB.PROJECTS.replace(/-/g, "")) return "setup"
    // If page has a Phase relation, it's a task
    const hasPhase = (page.properties?.["Phase"]?.relation || []).length > 0
    if (hasPhase) return "advance"
  } catch (e) {
    console.warn("[detectAction]", e.message)
  }
  return "setup"
}

// ─── HTML result page ─────────────────────────────────────────────────────────
function resultHTML(result) {
  const ok      = result.status === "advanced"
  const blocked = result.status === "blocked"
  const accent  = ok ? "#AAFF00" : blocked ? "#FBBF24" : "#FF4444"
  const icon    = ok ? "✓" : blocked ? "⚠" : "—"

  let title = "", msg = ""
  if (ok) {
    title = result.task
    msg   = `${result.from} → <strong style="color:${accent}">${result.to}</strong>`
    if (result.phase_update) msg += `<br><span style="opacity:.5">Phase → ${result.phase_update}</span>`
  } else if (blocked) {
    title = "Blocked"
    const list = (result.blockers || []).map(b => `<li>${b.name} <span style="opacity:.4">(${b.status})</span></li>`).join("")
    msg   = `<strong>${result.task}</strong> can't be completed yet.<br><ul style="text-align:left;margin-top:8px;padding-left:18px;list-style:disc">${list}</ul>`
  } else {
    title = result.task || "No change"
    msg   = result.message || "Task is already complete or has no next step."
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap" rel="stylesheet"/>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Satoshi',sans-serif;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:#191919;border:1px solid ${accent}22;border-radius:16px;padding:40px;max-width:420px;text-align:center;width:100%}
.icon{width:56px;height:56px;border-radius:50%;background:${accent}18;color:${accent};display:inline-flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;margin-bottom:16px}
h1{font-size:18px;font-weight:800;margin-bottom:8px;letter-spacing:-.02em}p{font-size:14px;color:rgba(255,255,255,.6);line-height:1.6}
.hint{margin-top:20px;font-size:12px;color:rgba(255,255,255,.25)}</style></head>
<body><div class="card"><div class="icon">${icon}</div><h1>${title}</h1><p>${msg}</p><p class="hint">You can close this tab and return to Notion.</p></div></body></html>`
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────
export async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization")
    return res.status(200).end()
  }

  if (req.method === "GET" && req.query.advance) {
    try {
      const result = await advanceTask({ page_id: req.query.advance })
      return res.setHeader("Content-Type", "text/html").status(200).send(resultHTML(result))
    } catch (e) {
      console.error("[setup_project] GET advance:", e)
      return res.setHeader("Content-Type", "text/html").status(200).send(
        resultHTML({ status: "error", task: "Error", message: e.message })
      )
    }
  }

  if (req.method === "GET") {
    return res.json({ service: "Opxio — Setup Project (config-driven)", status: "ready" })
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const body   = req.body || {}
  let   action = req.query?.action || body.action || ""

  try {
    if (!action) {
      action = await detectAction(body)
      console.log(`[setup_project] Auto-detected action: "${action}"`)
    }
    if (action === "advance") {
      const result = await advanceTask(body)
      return res.json(result)
    }
    const result = await setup(body)
    return res.json(result)
  } catch (e) {
    console.error("[setup_project]", e)
    return res.status(500).json({ error: e.message })
  }
}