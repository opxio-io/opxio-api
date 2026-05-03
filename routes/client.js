import { Router } from 'express'

import { handler as slugHandler  } from '../handlers/client/_slug.js'
import { handler as infoHandler  } from '../handlers/client/info.js'
import { handler as metaHandler  } from '../handlers/client/meta.js'
import { handler as syncClient   } from '../handlers/pipeline/sync-client.js'
import { handler as widgetAccess } from '../handlers/pipeline/widget-access.js'
import { handler as webhookDebug } from '../handlers/pipeline/webhook_debug.js'

const router = Router()

// Static routes MUST come before /:slug — Express matches in order
router.all('/info',          async (req, res) => { await infoHandler(req, res) })
router.all('/meta',          async (req, res) => { await metaHandler(req, res) })
router.all('/sync',          async (req, res) => { await syncClient(req, res) })
router.all('/widget-access', async (req, res) => { await widgetAccess(req, res) })
router.all('/webhook-debug', async (req, res) => { await webhookDebug(req, res) })
router.all('/:slug',         async (req, res) => { await slugHandler(req, res) })

export default router
