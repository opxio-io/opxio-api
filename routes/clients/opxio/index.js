import { Router } from 'express'
import { handler as salesPipeline }  from '../../../handlers/clients/opxio/sales-pipeline.js'
import { handler as entityContacts } from '../../../handlers/clients/opxio/entity-contacts.js'
import { handler as targets }        from '../../../handlers/clients/opxio/targets.js'
import { handler as quotesPipeline } from '../../../handlers/clients/opxio/quotes-pipeline.js'
import { handler as submitQc }       from '../../../handlers/clients/opxio/submit-qc.js'
import { handler as qcReview }       from '../../../handlers/clients/opxio/qc-review.js'
import { handler as oauthStart }     from '../../../handlers/clients/opxio/oauth-start.js'
import { handler as oauthCallback }  from '../../../handlers/clients/opxio/oauth-callback.js'

const router = Router()

router.all('/sales-pipeline',    async (req, res) => { await salesPipeline(req, res) })
router.all('/entity-contacts',   async (req, res) => { await entityContacts(req, res) })
router.all('/targets',           async (req, res) => { await targets(req, res) })
router.all('/quotes-pipeline',   async (req, res) => { await quotesPipeline(req, res) })
router.post('/submit-qc',        async (req, res) => { await submitQc(req, res) })
router.all('/qc-review',         async (req, res) => { await qcReview(req, res) })
router.get('/oauth/start',       async (req, res) => { await oauthStart(req, res) })
router.get('/oauth/callback',    async (req, res) => { await oauthCallback(req, res) })

export default router
