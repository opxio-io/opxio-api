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

const app = express()

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'] }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

app.get('/', (req, res) => res.json({ ok: true, service: 'opxio-api', ts: new Date().toISOString() }))
app.get('/health', (req, res) => res.json({ ok: true }))

app.use('/api',           pipelineRoutes)
app.use('/api',           documentRoutes)
app.use('/api/client',    clientRoutes)
app.use('/api/admin',     adminRoutes)
app.use('/api/data',      dataRoutes)
app.use('/api/creaitors', creaitorRoutes)
app.use('/api/marketing', marketingRoutes)
app.use('/api/operations',operationsRoutes)
app.use('/api/cupterra',              cupterraRoutes)
app.use('/api/clients/shin-supplies', cupterraRoutes)
app.use('/api/revenue',   revenueRoutes)
app.use('/api/executive', executiveRoutes)
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
  // Hits the real endpoint every 4 minutes via public URL so Railway sees
  // it as external traffic (prevents sleep) and cache stays warm.
  const WARM_TARGETS = [
    {
      label: 'shin-supplies/crm-pipeline',
      url:   'https://api.opxio.io/api/clients/shin-supplies/crm-pipeline?token=d3d18bd59d0b0a63252fe7c91264c69469a72b16fc059fd31b946c2d0b703182',
    },
  ]

  async function warmCache() {
    for (const target of WARM_TARGETS) {
      try {
        const t0 = Date.now()
        const r  = await fetch(target.url)
        const ms = Date.now() - t0
        const xc = r.headers.get('x-cache') || '?'
        console.log(`[warm] ${target.label} — ${xc} ${ms}ms`)
      } catch (e) {
        console.error(`[warm] ${target.label} failed:`, e.message)
      }
    }
  }

  // First warm after 30s (let server fully boot), then every 4 minutes
  setTimeout(() => {
    warmCache()
    setInterval(warmCache, 4 * 60 * 1000)
  }, 30_000)
})
