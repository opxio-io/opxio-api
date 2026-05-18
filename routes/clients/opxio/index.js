import { Router } from 'express'
import { handler as salesPipeline }  from '../../../handlers/clients/opxio/sales-pipeline.js'
import { handler as entityContacts } from '../../../handlers/clients/opxio/entity-contacts.js'
import { handler as targets }        from '../../../handlers/clients/opxio/targets.js'
import { handler as quotesPipeline } from '../../../handlers/clients/opxio/quotes-pipeline.js'

const router = Router()

router.all('/sales-pipeline',  async (req, res) => { await salesPipeline(req, res) })
router.all('/entity-contacts', async (req, res) => { await entityContacts(req, res) })
router.all('/targets',         async (req, res) => { await targets(req, res) })
router.all('/quotes-pipeline', async (req, res) => { await quotesPipeline(req, res) })

export default router
