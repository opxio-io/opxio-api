// handlers/clients/nadia-cats/dashboard.js
// Cat Health HQ — all cats, all databases, GS treatment tracking

import { cacheGet, cacheSet, cacheKey, cacheDelete } from "../../../lib/cache.js"
import { notionQueue } from "../../../lib/queue.js"

const NOTION_KEY   = process.env.NOTION_API_KEY
const TIMEOUT_MS   = 8_000

const CATS_DB       = 'ab482fba957f4ac1806ea8e5d3f29c10'
const MEDS_DB       = 'd6cf8fb4130546cf802765438423509e'
const VET_DB        = '66a79a4466eb44208e5d7792ba2db220'
const WEIGHT_DB     = '2607a62e450f499888f302fb105b15d6'
const SYMPTOMS_DB   = 'c7b6eb31b77a4e658900b95a6d262045'

const _inflight = new Map()

async function queryAll(dbId, notionKey) {
  const headers = {
    Authorization: `Bearer ${notionKey}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  }
  let results = [], hasMore = true, cursor
  while (hasMore) {
    const ctrl  = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const body = { page_size: 100 }
      if (cursor) body.start_cursor = cursor
      const d = await notionQueue.add(async () => {
        const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
          method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
        })
        if (!r.ok) throw new Error(`Notion ${r.status}: ${await r.text()}`)
        return r.json()
      })
      results = results.concat(d.results)
      hasMore  = d.has_more
      cursor   = d.next_cursor
    } finally {
      clearTimeout(timer)
    }
  }
  return results
}

// Property getters
const getTitle    = p => (p?.title      || []).map(t => t.plain_text).join('')
const getRichText = p => (p?.rich_text  || []).map(t => t.plain_text).join('')
const getSelect   = p => p?.select?.name  || p?.status?.name || null
const getMultiSel = p => (p?.multi_select || []).map(s => s.name)
const getDate     = p => p?.date?.start   || null
const getNumber   = p => p?.number        ?? null
const getCheckbox = p => p?.checkbox      === true
const getRelIds   = p => (p?.relation     || []).map(r => r.id)

function gsDayInfo(startDate) {
  if (!startDate) return null
  const start  = new Date(startDate)
  const today  = new Date()
  today.setHours(0, 0, 0, 0)
  start.setHours(0, 0, 0, 0)
  const diffMs  = today - start
  const day     = Math.floor(diffMs / 86400000) + 1
  const day42   = new Date(start); day42.setDate(start.getDate() + 41)
  const day84   = new Date(start); day84.setDate(start.getDate() + 83)
  return {
    day: Math.min(Math.max(day, 1), 84),
    pct: Math.min(Math.round((day / 84) * 100), 100),
    day42: day42.toISOString().slice(0, 10),
    day84: day84.toISOString().slice(0, 10),
    pastDay42: day > 42,
    completed: day > 84,
  }
}

function normId(id) { return id.replace(/-/g, '') }

function buildFetchPromise(ck, notionKey) {
  if (_inflight.has(ck)) return _inflight.get(ck)
  const p = Promise.all([
    queryAll(CATS_DB,     notionKey),
    queryAll(MEDS_DB,     notionKey),
    queryAll(VET_DB,      notionKey),
    queryAll(WEIGHT_DB,   notionKey).catch(() => []),
    queryAll(SYMPTOMS_DB, notionKey).catch(() => []),
  ]).then(([catPages, medPages, vetPages, weightPages, symptomPages]) => {

    // ── Cats ──────────────────────────────────────────────────────
    const cats = catPages.map(page => {
      const pp = page.properties
      return {
        id:             normId(page.id),
        name:           getTitle(pp['Name']),
        fipType:        getSelect(pp['FIP Type']),
        status:         getSelect(pp['Status']),
        conditions:     getMultiSel(pp['Conditions']),
        emergencyNotes: getRichText(pp['Emergency Notes']) || null,
        age:            getRichText(pp['Age']) || null,
        primaryVet:     getRichText(pp['Primary Vet']) || null,
        sex:            getSelect(pp['Sex']),
        dob:            getDate(pp['Date of Birth']),
      }
    }).sort((a, b) => a.name.localeCompare(b.name))

    // ── Medications ───────────────────────────────────────────────
    const medsMap = {}
    for (const page of medPages) {
      const pp     = page.properties
      const catIds = getRelIds(pp['Cat'])
      const startDate = getDate(pp['Start Date'])
      const category  = getSelect(pp['Med Category'])
      const med = {
        id:             page.id,
        name:           getTitle(pp['Medication Name']),
        dosage:         getRichText(pp['Dosage']) || null,
        unit:           getSelect(pp['Unit']),
        status:         getSelect(pp['Status']),
        category,
        purpose:        getRichText(pp['Purpose']) || null,
        morningDose:    getCheckbox(pp['Morning Dose']),
        afternoonDose:  getCheckbox(pp['Afternoon Dose']),
        eveningDose:    getCheckbox(pp['Evening Dose']),
        morningTime:    getRichText(pp['Morning Time'])    || null,
        afternoonTime:  getRichText(pp['Afternoon Time'])  || null,
        eveningTime:    getRichText(pp['Evening Time'])    || null,
        startDate,
        endDate:        getDate(pp['End Date']),
        pricePerUnit:   getNumber(pp['Price per Unit (RM)']),
        pricePerCourse: getNumber(pp['Price per Course (RM)']),
        supplier:       getRichText(pp['Supplier / Source']) || null,
        sideEffects:    getRichText(pp['Side Effects to Watch']) || null,
        // GS-specific
        gsForm:          getSelect(pp['GS Form']),
        gsConcentration: getRichText(pp['GS Concentration']) || null,
        day42Milestone:  getDate(pp['Day 42 Milestone']),
        day84Completion: getDate(pp['Day 84 Completion']),
        gsProgress:      category === 'GS Treatment' ? gsDayInfo(startDate) : null,
      }
      for (const catId of catIds) {
        const cid = normId(catId)
        if (!medsMap[cid]) medsMap[cid] = []
        medsMap[cid].push(med)
      }
    }

    // ── Vet Visits ────────────────────────────────────────────────
    const vetMap = {}
    for (const page of vetPages) {
      const pp     = page.properties
      const catIds = getRelIds(pp['Cat'])
      const visit  = {
        id:              page.id,
        title:           getTitle(pp['Visit Title']),
        date:            getDate(pp['Date']),
        visitType:       getSelect(pp['Visit Type']),
        clinic:          getRichText(pp['Clinic / Hospital']) || null,
        vetName:         getRichText(pp['Vet Name']) || null,
        chiefComplaint:  getRichText(pp['Chief Complaint']) || null,
        diagnosis:       getRichText(pp['Diagnosis']) || null,
        treatment:       getRichText(pp['Treatment Done']) || null,
        cost:            getNumber(pp['Cost (RM)']),
        nextAppointment: getDate(pp['Next Appointment']),
        weightAtVisit:   getNumber(pp['Weight at Visit (kg)']),
      }
      for (const catId of catIds) {
        const cid = normId(catId)
        if (!vetMap[cid]) vetMap[cid] = []
        vetMap[cid].push(visit)
      }
    }

    // ── Weight Log ────────────────────────────────────────────────
    const weightMap = {}
    for (const page of weightPages) {
      const pp     = page.properties
      const catIds = getRelIds(pp['Cat'])
      const entry  = {
        id:         page.id,
        date:       getDate(pp['Date']),
        weight:     getNumber(pp['Weight (kg)']),
        trend:      getSelect(pp['Trend']),
        measuredBy: getSelect(pp['Measured By']),
        notes:      getRichText(pp['Notes']) || null,
      }
      for (const catId of catIds) {
        const cid = normId(catId)
        if (!weightMap[cid]) weightMap[cid] = []
        weightMap[cid].push(entry)
      }
    }

    // ── Symptoms ──────────────────────────────────────────────────
    const symptomsMap = {}
    for (const page of symptomPages) {
      const pp     = page.properties
      const catIds = getRelIds(pp['Cat'])
      const entry  = {
        id:          page.id,
        title:       getTitle(pp['Entry Title']),
        date:        getDate(pp['Date']),
        symptoms:    getMultiSel(pp['Symptoms']),
        severity:    getSelect(pp['Severity']),
        description: getRichText(pp['Description']) || null,
        resolved:    getCheckbox(pp['Resolved']),
        actionTaken: getRichText(pp['Action Taken']) || null,
        followUp:    getCheckbox(pp['Follow-up Required']),
      }
      for (const catId of catIds) {
        const cid = normId(catId)
        if (!symptomsMap[cid]) symptomsMap[cid] = []
        symptomsMap[cid].push(entry)
      }
    }

    const byDate = (a, b) => (b.date || '').localeCompare(a.date || '')

    const result = cats.map(cat => {
      const meds    = (medsMap[cat.id]    || []).sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''))
      const visits  = (vetMap[cat.id]     || []).sort(byDate)
      const weights = (weightMap[cat.id]  || []).sort(byDate)
      const symptoms = (symptomsMap[cat.id] || []).sort(byDate)

      const activeMeds = meds.filter(m => m.status === 'Active')
      const gsActive   = activeMeds.find(m => m.category === 'GS Treatment')

      return {
        ...cat,
        gsActive: gsActive || null,
        medications:    meds,
        activeMeds,
        vetVisits:      visits,
        weightLog:      weights,
        symptoms,
        latestWeight:   weights[0]?.weight ?? null,
        latestWeightDate: weights[0]?.date ?? null,
        lastVisitDate:  visits[0]?.date ?? null,
        nextAppt:       visits.find(v => v.nextAppointment)?.nextAppointment ?? null,
      }
    })

    const fresh = { cats: result, total: cats.length }
    cacheSet(ck, fresh)
    return fresh
  }).finally(() => _inflight.delete(ck))
  _inflight.set(ck, p)
  return p
}

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Widget-Token')
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const notionKey = NOTION_KEY
  if (!notionKey) return res.status(503).json({ error: 'NADIA_NOTION_KEY not configured' })

  const ck = cacheKey('nadia-cats:dashboard')
  if (req.query.force === '1') cacheDelete(ck)

  const hit = cacheGet(ck)
  if (hit && !hit.stale) {
    res.setHeader('X-Cache', 'HIT')
    return res.status(200).json({ ...hit.data, updatedAt: new Date().toISOString() })
  }
  if (hit && hit.stale) {
    res.setHeader('X-Cache', 'STALE')
    res.status(200).json({ ...hit.data, updatedAt: new Date().toISOString() })
    buildFetchPromise(ck, notionKey).catch(e => console.error('[nadia-cats] bg refresh:', e.message))
    return
  }

  try {
    const data = await buildFetchPromise(ck, notionKey)
    res.setHeader('X-Cache', 'MISS')
    res.status(200).json({ ...data, updatedAt: new Date().toISOString() })
  } catch (e) {
    console.error('[nadia-cats] fetch error:', e.message)
    res.status(503).json({ error: 'Notion unavailable. Try again shortly.' })
  }
}
