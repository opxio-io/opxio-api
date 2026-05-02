// /api/private/milestone
// Personal weight loss milestone tracker — Kai's private widget
// DBs: Weight Log · Milestones · Reward Menu (all in Opxio workspace)

import { queryDB, plain } from "../../../lib/notion"

const WEIGHT_LOG_DB  = "43b574d8273a4ac3ac101e9eddcac4e6"
const MILESTONES_DB  = "9ee6834c98d94ecc92ae38679fd65378"
const REWARD_MENU_DB = "5c58fa3602e84878a320a15ec02e82f5"

const START_WEIGHT = 125
const GOAL_WEIGHT  = 60   // ultimate goal — drives overall progress bar
const START_DATE   = "April 2024"

export async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end()
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120")

  const token = req.query.token || req.headers["x-widget-token"]
  const validToken = process.env.PRIVATE_WIDGET_TOKEN || "kai-journey-2026"
  if (!token || token !== validToken) return res.status(403).json({ error: "Forbidden" })

  try {
    const notionToken = process.env.NOTION_API_KEY

    const [weightLogs, milestones, rewards] = await Promise.all([
      queryDB(WEIGHT_LOG_DB,  null, notionToken),
      queryDB(MILESTONES_DB,  null, notionToken),
      queryDB(REWARD_MENU_DB, null, notionToken),
    ])

    // ── Weight logs — sorted newest first ──────────────────────────────────
    const logs = weightLogs
      .map(log => {
        const p = log.properties
        return {
          id:     log.id,
          name:   plain(p["Name"]?.title || []),
          date:   p["Date"]?.date?.start || log.created_time,
          weight: p["Weight (kg)"]?.number ?? null,
          height: p["Height (cm)"]?.number ?? null,
          bmi:    p["BMI"]?.formula?.number ?? null,
          notes:  plain(p["Notes"]?.rich_text || []),
        }
      })
      .filter(l => l.weight !== null)
      .sort((a, b) => new Date(b.date) - new Date(a.date))

    const currentWeight = logs[0]?.weight ?? null
    const currentBMI    = logs[0]?.bmi    ?? null

    // ── Milestones — sorted by target weight descending (88→85→82…) ────────
    const milestoneList = milestones
      .map(m => {
        const p = m.properties
        return {
          id:           m.id,
          name:         plain(p["Milestone"]?.title || []),
          targetWeight: p["Target Weight (kg)"]?.number ?? null,
          deadline:     p["Deadline"]?.date?.start ?? null,
          status:       p["Status"]?.select?.name ?? "Upcoming",
          foodReward:   plain(p["Food Reward"]?.rich_text || []),
          rewardLocation: plain(p["Reward Location"]?.rich_text || []),
          dateAchieved: p["Date Achieved"]?.date?.start ?? null,
          dateClaimed:  p["Date Claimed"]?.date?.start ?? null,
          bonusTarget:  p["Bonus Target (kg)"]?.number ?? null,
          bonusReward:  plain(p["Bonus Reward"]?.rich_text || []),
          bonusAchieved: p["Bonus Achieved"]?.checkbox ?? false,
          bonusClaimed:  p["Bonus Claimed"]?.checkbox ?? false,
        }
      })
      .sort((a, b) => (b.targetWeight ?? 0) - (a.targetWeight ?? 0))

    // ── Reward menu items — attach to milestones ────────────────────────────
    const rewardList = rewards.map(r => {
      const p = r.properties
      return {
        id:       r.id,
        dish:     plain(p["Dish"]?.title || []),
        location: plain(p["Restaurant / Location"]?.rich_text || []),
        category: p["Category"]?.select?.name ?? null,
        type:     p["Type"]?.select?.name ?? null,
        status:   p["Status"]?.select?.name ?? "Locked",
        notes:    plain(p["Notes"]?.rich_text || []),
        milestoneIds: (p["Milestone"]?.relation ?? []).map(r => r.id),
      }
    })

    const enrichedMilestones = milestoneList.map(m => ({
      ...m,
      rewards: rewardList.filter(r => r.milestoneIds.some(id =>
        id.replace(/-/g, "") === m.id.replace(/-/g, "")
      )),
    }))

    // ── Journey stats ───────────────────────────────────────────────────────
    const lostTotal      = currentWeight !== null ? +(START_WEIGHT - currentWeight).toFixed(2) : null
    const journeyProgress = currentWeight !== null
      ? +( (START_WEIGHT - currentWeight) / (START_WEIGHT - GOAL_WEIGHT) * 100 ).toFixed(1)
      : null

    res.status(200).json({
      startWeight:  START_WEIGHT,
      goalWeight:   GOAL_WEIGHT,
      startDate:    START_DATE,
      currentWeight,
      currentBMI,
      lostTotal,
      journeyProgress,
      logs: logs.slice(0, 10),
      milestones: enrichedMilestones,
    })
  } catch (err) {
    console.error("[milestone]", err)
    res.status(500).json({ error: err.message })
  }
}