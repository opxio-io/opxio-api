import { Router } from 'express'
import { handler as salesPipeline }   from '../../../handlers/clients/opxio/sales-pipeline.js'
import { handler as entityContacts }  from '../../../handlers/clients/opxio/entity-contacts.js'

const router = Router()

router.all('/sales-pipeline',   async (req, res) => { await salesPipeline(req, res) })
router.all('/entity-contacts',  async (req, res) => { await entityContacts(req, res) })

export default router
