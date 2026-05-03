import { Router } from 'express'

import { handler as clients }       from '../handlers/admin/clients.js'
import { handler as widgetConfigs } from '../handlers/admin/widget-configs.js'

const router = Router()

router.all('/clients',                      async (req, res) => { await clients(req, res) })
router.all('/widget-configs',               async (req, res) => { req.params.clientId = null; await widgetConfigs(req, res) })
router.all('/widget-configs/:clientId',     async (req, res) => { await widgetConfigs(req, res) })

export default router
