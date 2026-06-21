// routes/clients/pointgate/index.js
import { Router } from 'express'
import { handler as statementHandler }  from '../../../handlers/clients/pointgate/statement.js'
import { handler as dashboardHandler }  from '../../../handlers/clients/pointgate/dashboard.js'
import { handler as paymentHandler }    from '../../../handlers/clients/pointgate/payment.js'
import { handler as receiptHandler }    from '../../../handlers/clients/pointgate/receipt.js'

const router = Router()

router.post('/statement', statementHandler)
router.get('/statement',  statementHandler)
router.get('/dashboard',  dashboardHandler)
router.patch('/payment',  paymentHandler)
router.post('/payment',   paymentHandler)
router.post('/receipt',   receiptHandler)

router.get('/', (_req, res) => res.json({ ok: true, client: 'pointgate' }))

export default router
