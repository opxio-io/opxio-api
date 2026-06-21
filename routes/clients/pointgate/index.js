// routes/clients/pointgate/index.js
import { Router } from 'express'
import { handler as statementHandler }  from '../../../handlers/clients/pointgate/statement.js'
import { handler as dashboardHandler }  from '../../../handlers/clients/pointgate/dashboard.js'

const router = Router()

// POST /api/clients/pointgate/statement
// Triggered by Notion button automation with the Tenant page_id.
router.post('/statement', statementHandler)
router.get('/statement',  statementHandler)  // GET for manual testing

// GET /api/clients/pointgate/dashboard?month=2026-06&block=3416&status=Paid
router.get('/dashboard', dashboardHandler)

router.get('/', (_req, res) => res.json({ ok: true, client: 'pointgate' }))

export default router
