import { Router } from 'express'

import { handler as getById          } from '../../handlers/proposals/_id.js'
import { handler as catalogueOptions } from '../../handlers/proposals/catalogue-options.js'
import { handler as list             } from '../../handlers/proposals/list.js'

const router = Router()

router.all('/:id', async (req, res) => { await getById(req, res) })
router.all('/catalogue-options', async (req, res) => { await catalogueOptions(req, res) })
router.all('/list', async (req, res) => { await list(req, res) })

export default router