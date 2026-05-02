// /api/data/forecast — Opxio Revenue Forecasting Dashboard
// Queries Deals DB + Invoice DB + Leads DB in parallel
// Returns pipeline summary, revenue collected, conversion stats, monthly trends

import { queryDB, plain, DB } from "../../../lib/notion"
import { getClientByToken, getNotionToken, resolveDB, checkOrigin } from "../../../lib/supabase"

const PIPELINE_STAGES = ["Proposal", "Proposal Sent", "Negotiation"]
const WON_STAGES      = ["Awaiting Deposit", "Closed Won"]
const LOST_STAGE      = "Closed Lost"
const PAID_STATUSES   = ["deposit received", "paid", "completed", "final paid", "balance paid"]

export async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120")

  try {
    const accessToken = req.query.token || req.headers["x-widget-token"]
    if (!accessToken) return res.status(401).json({ error: "Missing token" })

    const client = await getClientByToken(accessToken)
    if (!client) return res.status(403).json({ error: "Invalid token" })
    if (!checkOrigin(client, req)) return res.status(403).json({ error: "Origin not allowed" })

    const notionToken = getNotionToken(client)
    const DEALS_DB    = resolveDB(client, "DEALS",   DB.DEALS)
    const INVOICE_DB  = resolveDB(client, "INVOICE", DB.INVOICE)
    const LEADS_DB    = resolveDB(client, "LEADS",   DB.LEADS)

    const now   = new Date()
    const year  = now.getFullYear()
    const month = now.getMonth() // 0-indexed

    // ── Build 6-month bucket keys ─────────────────────────────────────────
    const monthlyRevenue = {}
    const monthlyDeals   = {}
    for (let i = 5; i >= 0; i--) {
      const d   = new Date(year, month - i, 1)
      const key = d.toLocaleString("default", { month: "short", year: "2-digit" })
      monthlyRevenue[key] = 0
      monthlyDeals[key]   = 0
    }

    // ── Fetch all three DBs in parallel ───────────────────────────────────
    const [deals, invoices, leads] = await Promise.all([
      queryDB(DEALS_DB,   null, notionToken),
      queryDB(INVOICE_DB, null, notionToken).catch(() => []),
      queryDB(LEADS_DB,   null, notionToken).catch(() => []),
    ])

    // ── Process Deals ─────────────────────────────────────────────────────
    const allStages = [...PIPELINE_STAGES, ...WON_STAGES, LOST_STAGE]
    const stageCount = Object.fromEntries(allStages.map(s => [s, 0]))
    const stageValue = Object.fromEntries(allStages.map(s => [s, 0]))

    let pipelineValue  = 0
    let wonTotalCount  = 0
    let lostTotalCount = 0
    let wonThisMonth   = 0
    let wonThisMonthVal = 0
    let avgDealSum     = 0
    let avgDealCount   = 0
    const pipelineDeals = []
    const sourceCount  = {}

    for (const deal of deals) {
      const p     = deal.properties
      const stage = p.Stage?.status?.name || p.Stage?.select?.name || "Unknown"
      const value = p["Deal Value"]?.number || p["Total Value"]?.number || 0
      const name  = plain(p["Deal Name"]?.title || p.Name?.title || []) || "Untitled"
      const pkgs  = p.Packages?.multi_select?.map(x => x.name) || []
      const src   = p.Source?.select?.name || null
      const created = new Date(deal.created_time)
      const isTM  = created.getMonth() === month && created.getFullYear() === year
      const mKey  = created.toLocaleString("default", { month: "short", year: "2-digit" })

      if (stage in stageCount) {
        stageCount[stage]++
        stageValue[stage] += value
      }

      if (PIPELINE_STAGES.includes(stage)) {
        pipelineValue += value
        if (value > 0) { avgDealSum += value; avgDealCount++ }
        pipelineDeals.push({
          name,
          stage,
          value,
          pkg: pkgs[0] || null,
          url: `https://notion.so/${deal.id.replace(/-/g, "")}`,
        })
      }

      if (WON_STAGES.includes(stage)) {
        wonTotalCount++
        if (value > 0) { avgDealSum += value; avgDealCount++ }
        if (isTM) { wonThisMonth++; wonThisMonthVal += value }
      }

      if (stage === LOST_STAGE) lostTotalCount++

      if (mKey in monthlyDeals) monthlyDeals[mKey]++

      if (src) sourceCount[src] = (sourceCount[src] || 0) + 1
    }

    const totalClosed = wonTotalCount + lostTotalCount
    const winRate     = totalClosed > 0 ? Math.round((wonTotalCount / totalClosed) * 100) : null
    const avgDeal     = avgDealCount  > 0 ? Math.round(avgDealSum / avgDealCount) : null

    // ── Process Invoices ──────────────────────────────────────────────────
    let revenueCollectedMTD = 0
    let outstanding         = 0
    let overdueCount        = 0
    const today = now.toISOString().slice(0, 10)

    for (const inv of invoices) {
      const p       = inv.properties
      const status  = (p.Status?.select?.name || p.Status?.status?.name || "").toLowerCase()
      const amount  = p["Amount"]?.number || p["Amount (MYR)"]?.number || 0
      const issueDate = p["Issue Date"]?.date?.start || p["Created On"]?.date?.start || inv.created_time
      const dueDate   = p["Deposit Due"]?.date?.start || p["Due Date"]?.date?.start || null
      const iDate   = new Date(issueDate)
      const isTM    = iDate.getMonth() === month && iDate.getFullYear() === year
      const mKey    = iDate.toLocaleString("default", { month: "short", year: "2-digit" })
      const isPaid  = PAID_STATUSES.some(s => status.includes(s))
      const isCancelled = status === "cancelled" || status === "void"

      if (isCancelled) continue

      if (isPaid) {
        if (isTM) revenueCollectedMTD += amount
        if (mKey in monthlyRevenue) monthlyRevenue[mKey] += amount
      } else {
        outstanding += amount
        if (dueDate && dueDate < today) overdueCount++
      }
    }

    // ── Process Leads ─────────────────────────────────────────────────────
    let leadsThisMonth = 0
    let leadsConverted = 0
    let leadsLost      = 0

    for (const lead of leads) {
      const p     = lead.properties
      const stage = p.Stage?.status?.name || p.Stage?.select?.name || ""
      const created = new Date(lead.created_time)
      const isTM  = created.getMonth() === month && created.getFullYear() === year

      if (!isTM) continue
      leadsThisMonth++
      if (stage === "Converted") leadsConverted++
      if (["Lost", "Ghosted", "Unqualified"].includes(stage)) leadsLost++
    }

    const convTotal = leadsConverted + leadsLost
    const convRate  = convTotal > 0 ? Math.round((leadsConverted / convTotal) * 100) : null

    // Sort pipeline deals by value desc, cap at 6
    pipelineDeals.sort((a, b) => b.value - a.value)

    // Source breakdown sorted
    const sources = Object.entries(sourceCount)
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ label, count }))

    res.status(200).json({
      // Pipeline
      pipelineValue,
      pipelineStages: PIPELINE_STAGES.map(s => ({
        stage: s,
        count: stageCount[s] || 0,
        value: stageValue[s] || 0,
      })),
      wonStages: WON_STAGES.map(s => ({
        stage: s,
        count: stageCount[s] || 0,
        value: stageValue[s] || 0,
      })),
      lostCount:      stageCount[LOST_STAGE] || 0,
      winRate,
      avgDeal,
      wonThisMonth,
      wonThisMonthVal,
      pipelineDeals:  pipelineDeals.slice(0, 6),
      sources,

      // Revenue
      revenueCollectedMTD,
      outstanding,
      overdueCount,

      // Trends
      monthlyRevenue: Object.entries(monthlyRevenue).map(([m, v]) => ({ m, v })),
      monthlyDeals:   Object.entries(monthlyDeals).map(([m, v]) => ({ m, v })),

      // Leads
      leadsThisMonth,
      leadsConverted,
      convRate,

      // Meta
      monthLabel: now.toLocaleString("default", { month: "long", year: "numeric" }),
    })
  } catch (err) {
    console.error("[forecast]", err)
    res.status(500).json({ error: err.message })
  }
}