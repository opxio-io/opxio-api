import { Router } from 'express'

import { handler as generate } from '../handlers/generate.js'
import { handler as createProposal } from '../handlers/create_proposal.js'
import { handler as acceptProposal } from '../handlers/accept_proposal.js'
import { handler as convertProposal } from '../handlers/convert_proposal.js'
import { handler as sendQuotation } from '../handlers/send_quotation.js'
import { handler as waRedirect } from '../handlers/wa_redirect.js'

const router = Router()

router.all('/generate', async (req, res) => { await generate(req, res) })
router.all('/create_proposal', async (req, res) => { await createProposal(req, res) })
router.all('/accept_proposal', async (req, res) => { await acceptProposal(req, res) })
router.all('/convert_proposal', async (req, res) => { await convertProposal(req, res) })
router.all('/send_quotation', async (req, res) => { await sendQuotation(req, res) })
router.all('/wa_redirect', async (req, res) => { await waRedirect(req, res) })

export default router