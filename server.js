import 'dotenv/config'
import express from 'express'
import cors from 'cors'

import pipelineRoutes   from './routes/pipeline.js'
import documentRoutes   from './routes/documents.js'
import clientRoutes     from './routes/client.js'
import adminRoutes      from './routes/admin.js'
import dataRoutes       from './routes/data/index.js'
import creaitorRoutes   from './routes/clients/creaitors/index.js'
import marketingRoutes  from './routes/clients/creaitors/marketing/index.js'
import operationsRoutes from './routes/clients/creaitors/operations/index.js'
import cupterraRoutes   from './routes/clients/shin-supplies/index.js'
import revenueRoutes    from './routes/clients/creaitors/revenue/index.js'
import executiveRoutes  from './routes/clients/creaitors/executive/index.js'
import portalRoutes     from './routes/portal/index.js'
import proposalRoutes   from './routes/proposals/index.js'
import privateRoutes    from './routes/private/index.js'

// ── Global crash guards ─────────────────────────────────────────────────────
// Prevent a single bad promise from killing the whole Railway process.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[crash-guard] Unhandled rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[crash-guard] Uncaught exception:', err)
})

const app = express()

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'] }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))


// ── Widget origin guard ──────────────────────────────────────────────────
// Only requests from widgets.opxio.io (or localhost in dev) may call client
// data endpoints. Browser fetch always sends Origin; block everything else.
const WIDGET_ORIGINS = [
  'https://widgets.opxio.io',
  'https://opxio.io',
]
function widgetOriginGuard(req, res, next) {
  const origin = req.headers.origin || ''
  const isLocal = origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')
  const isAllowed = !origin || isLocal || WIDGET_ORIGINS.some(o => origin === o)
  if (!isAllowed) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  next()
}

app.get('/', (req, res) => res.json({ ok: true, service: 'opxio-api', ts: new Date().toISOString() }))
app.get('/health', (req, res) => res.json({ ok: true }))

app.use('/api',           pipelineRoutes)
app.use('/api',           documentRoutes)
app.use('/api/client',    clientRoutes)
app.use('/api/admin',     adminRoutes)
app.use('/api/data',      dataRoutes)

// Creaitors — legacy paths (keep for backward compat)
app.use('/api/creaitors', widgetOriginGuard,   creaitorRoutes)
app.use('/api/marketing',   widgetOriginGuard, marketingRoutes)
app.use('/api/operations',  widgetOriginGuard, operationsRoutes)
app.use('/api/revenue',     widgetOriginGuard, revenueRoutes)
app.use('/api/executive',   widgetOriginGuard, executiveRoutes)

// Creaitors — canonical paths (widgets now call these)
app.use('/api/clients/creaitors', widgetOriginGuard,             creaitorRoutes)
app.use('/api/clients/creaitors/marketing',   widgetOriginGuard, marketingRoutes)
app.use('/api/clients/creaitors/operations',  widgetOriginGuard, operationsRoutes)
app.use('/api/clients/creaitors/revenue',     widgetOriginGuard, revenueRoutes)
app.use('/api/clients/creaitors/executive',   widgetOriginGuard, executiveRoutes)

// Shin Supplies
app.use('/api/cupterra',              widgetOriginGuard, cupterraRoutes)
app.use('/api/clients/shin-supplies', widgetOriginGuard, cupterraRoutes)

app.use('/api/portal',    portalRoutes)
app.use('/api/proposals', proposalRoutes)
app.use('/api/private',   privateRoutes)

app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }))
app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: err.message || 'Internal server error' })
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`opxio-api running on port ${PORT}`)

  // ── Cache warmer — keeps Railway awake + cache hot ────────────────────
  // Hits each real endpoint every 4 minutes. Railway sees this as external
  // traffic (prevents sleep). Cache stays warm for all clients.
  const CREAITORS_TOKEN = 'f647b9df0a380951e524f18de1194faac46cdac82694bfb15fb032f13fab00d1'
  const SHIN_TOKEN      = 'd3d18bd59d0b0a63252fe7c91264c69469a72b16fc059fd31b946c2d0b703182'
  const BASE            = 'https://api.opxio.io/api/clients'

  const WARM_TARGETS = [
    // Shin Supplies
    { label: 'shin-supplies/crm-pipeline',      url: `${BASE}/shin-supplies/crm-pipeline?token=${SHIN_TOKEN}` },
    // Creaitors — root handlers
    { label: 'creaitors/crm',                   url: `${BASE}/creaitors/crm?token=${CREAITORS_TOKEN}` },
    { label: 'creaitors/campaign-stats',         url: `${BASE}/creaitors/campaign-stats?token=${CREAITORS_TOKEN}` },
    { label: 'creaitors/content-stats',          url: `${BASE}/creaitors/content-stats?token=${CREAITORS_TOKEN}` },
    { label: 'creaitors/employee-stats',         url: `${BASE}/creaitors/employee-stats?token=${CREAITORS_TOKEN}` },
    { label: 'creaitors/kol-data',               url: `${BASE}/creaitors/kol-data?token=${CREAITORS_TOKEN}` },
    { label: 'creaitors/bottlenecks',            url: `${BASE}/creaitors/bottlenecks?token=${CREAITORS_TOKEN}` },
    { label: 'creaitors/sales',                  url: `${BASE}/creaitors/sales?token=${CREAITORS_TOKEN}` },
    { label: 'creaitors/projects',               url: `${BASE}/creaitors/projects?token=${CREAITORS_TOKEN}` },
    // Creaitors — marketing subdir
    { label: 'creaitors/marketing/campaign-stats',  url: `${BASE}/creaitors/marketing/campaign-stats?token=${CREAITORS_TOKEN}` },
    { label: 'creaitors/marketing/content-stats',   url: `${BASE}/creaitors/marketing/content-stats?token=${CREAITORS_TOKEN}` },
    { label: 'creaitors/marketing/employee-stats',  url: `${BASE}/creaitors/marketing/employee-stats?token=${CREAITORS_TOKEN}` },
    { label: 'creaitors/marketing/staff-breakdown', url: `${BASE}/creaitors/marketing/staff-breakdown?token=${CREAITORS_TOKEN}` },
    { label: 'creaitors/marketing/bottlenecks',     url: `${BASE}/creaitors/marketing/bottlenecks?token=${CREAITORS_TOKEN}` },
    { label: 'creaitors/marketing/crm',             url: `${BASE}/creaitors/marketing/crm?token=${CREAITORS_TOKEN}` },
    // Creaitors — operations
    { label: 'creaitors/operations/bottlenecks',    url: `${BASE}/creaitors/operations/bottlenecks?token=${CREAITORS_TOKEN}` },
    // Creaitors — revenue
    { label: 'creaitors/revenue/crm',               url: `${BASE}/creaitors/revenue/crm?token=${CREAITORS_TOKEN}` },
  ]

  async function warmCache() {
    for (const target of WARM_TARGETS) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 15_000) // 15s max per endpoint
      try {
        const t0 = Date.now()
        const r  = await fetch(target.url, { signal: ac.signal })
        clearTimeout(timer)
        const ms = Date.now() - t0
        const xc = r.headers.get('x-cache') || '?'
        console.log(`[warm] ${target.label} — ${xc} ${ms}ms`)
      } catch (e) {
        clearTimeout(timer)
        if (e.name === 'AbortError') {
          console.warn(`[warm] ${target.label} — timed out after 15s`)
        } else {
          console.error(`[warm] ${target.label} failed:`, e.message)
        }
      }
    }
  }

  // First warm after 30s (let server fully boot), then every 4 minutes
  setTimeout(() => {
    warmCache()
    setInterval(warmCache, 4 * 60 * 1000)
  }, 30_000)
})
