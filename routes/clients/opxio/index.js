import { Router } from 'express'
import { handler as salesPipeline } from '../../../handlers/clients/opxio/sales-pipeline.js'

const router = Router()

router.all('/sales-pipeline', async (req, res) => { await salesPipeline(req, res) })

export default router
