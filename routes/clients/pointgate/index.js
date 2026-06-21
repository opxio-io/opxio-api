// routes/clients/pointgate/index.js
import { Router } from 'express'
import { handler as statementHandler }  from '../../../handlers/clients/pointgate/statement.js'
import { handler as dashboardHandler }  from '../../../handlers/clients/pointgate/dashboard.js'
import { handler as paymentHandler }    from '../../../handlers/clients/pointgate/payment.js'

const router = Router()

// POST /api/clients/pointgate/statement — Notion button automation
router.post('/statement', statementHandler)
router.get('/statement',  statementHandler)

// GET  /api/clients/pointgate/dashboard?month=2026-06&block=3416&status=Paid
router.get('/dashboard', dashboardHandler)

// PATCH /api/clients/pointgate/payment — inline edit from widget
router.patch('/payment', paymentHandler)
router.post('/payment',  paymentHandler)  // fallback for strict CORS

router.get('/', (_req, res) => res.json({ ok: true, client: 'pointgate' }))

export default router
