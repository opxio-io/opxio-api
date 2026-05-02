import { Router } from 'express'

import { handler as logWeight  } from '../../handlers/private/log-weight.js'
import { handler as milestone  } from '../../handlers/private/milestone.js'

const router = Router()

router.all('/log-weight', async (req, res) => { await logWeight(req, res) })
router.all('/milestone', async (req, res) => { await milestone(req, res) })

export default router