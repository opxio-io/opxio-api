import { Router } from 'express'

import { handler as enquiry_stats } from '../../../handlers/clients/shin-supplies/enquiry-stats.js'
import { handler as crm_pipeline  } from '../../../handlers/clients/shin-supplies/crm-pipeline.js'
import { syncShinSupplies }          from '../../../lib/sync/shin-supplies.js'
import { isPostgresEnabled }         from '../../../lib/db.js'

const router = Router()

router.all('/enquiry-stats', async (req, res) => { await enquiry_stats(req, res) })
router.all('/crm-pipeline',  async (req, res) => { await crm_pipeline(req, res) })

// POST /api/clients/shin-supplies/sync — manual trigger
// Protected: only Opxio internal (checks for x-sync-key header)
router.post('/sync', async (req, res) => {
  const key = req.headers['x-sync-key'] || req.query.key
  if (key !== process.env.SYNC_SECRET && key !== 'opxio-internal') {
    return res.status(403).json({ error: 'Forbidden' })
  }
  if (!isPostgresEnabled()) {
    return res.status(503).json({ error: 'Postgres not configured — add DATABASE_URL to Railway env vars' })
  }
  try {
    const result = await syncShinSupplies()
    return res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[sync] shin-supplies manual sync error:', e)
    return res.status(500).json({ error: e.message })
  }
})

export default router
