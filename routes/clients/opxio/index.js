import { Router } from 'express'
import { handler as salesPipeline }   from '../../../handlers/clients/opxio/sales-pipeline.js'
import { handler as entityContacts }  from '../../../handlers/clients/opxio/entity-contacts.js'
import { handler as targets }         from '../../../handlers/clients/opxio/targets.js'
import { handler as quotesPipeline }  from '../../../handlers/clients/opxio/quotes-pipeline.js'
import { handler as submitQc }        from '../../../handlers/clients/opxio/submit-qc.js'
import { handler as qcReview }        from '../../../handlers/clients/opxio/qc-review.js'
import { handler as qcAction }        from '../../../handlers/clients/opxio/qc-action.js'
import { handler as debugWebhook }    from '../../../handlers/clients/opxio/debug-webhook.js'

const router = Router()

router.all('/sales-pipeline',   async (req, res) => { await salesPipeline(req, res) })
router.all('/entity-contacts',  async (req, res) => { await entityContacts(req, res) })
router.all('/targets',          async (req, res) => { await targets(req, res) })
router.all('/quotes-pipeline',  async (req, res) => { await quotesPipeline(req, res) })
router.post('/submit-qc',       async (req, res) => { await submitQc(req, res) })
router.get('/qc-review',        async (req, res) => { await qcReview(req, res) })
router.post('/qc-action',       async (req, res) => { await qcAction(req, res) })
router.all('/debug-webhook',    async (req, res) => { await debugWebhook(req, res) })

export default router
