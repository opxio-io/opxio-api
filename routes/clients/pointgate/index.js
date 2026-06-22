// routes/clients/pointgate/index.js
import { Router } from 'express'
import { handler as statementHandler }     from '../../../handlers/clients/pointgate/statement.js'
import { handler as dashboardHandler }     from '../../../handlers/clients/pointgate/dashboard.js'
import { handler as paymentHandler }       from '../../../handlers/clients/pointgate/payment.js'
import { handler as receiptHandler }       from '../../../handlers/clients/pointgate/receipt.js'
import { handler as invoiceHandler }       from '../../../handlers/clients/pointgate/invoice.js'
import { handler as notifyOverdueHandler } from '../../../handlers/clients/pointgate/notify-overdue.js'
import { listHandler as overdueListHandler, sendHandler as overdueSendHandler } from '../../../handlers/clients/pointgate/overdue.js'
import { handler as propertiesHandler }        from '../../../handlers/clients/pointgate/properties.js'

const router = Router()

router.post('/statement',       statementHandler)
router.get('/statement',        statementHandler)
router.get('/dashboard',        dashboardHandler)
router.patch('/payment',        paymentHandler)
router.post('/payment',         paymentHandler)
router.post('/receipt',         receiptHandler)
router.post('/invoice',         invoiceHandler)
router.post('/notify-overdue',  notifyOverdueHandler)
router.get('/overdue',          overdueListHandler)
router.get('/properties',       propertiesHandler)
router.post('/overdue/send',    overdueSendHandler)

router.get('/', (_req, res) => res.json({ ok: true, client: 'pointgate' }))

export default router
