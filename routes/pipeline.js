import { Router } from 'express'

import { handler as qualify } from '../handlers/pipeline/qualify.js'
import { handler as calWebhook } from '../handlers/pipeline/cal-webhook.js'
import { handler as convertToDeal } from '../handlers/pipeline/convert_to_deal.js'
import { handler as createQuotation } from '../handlers/pipeline/create_quotation.js'
import { handler as createInvoice } from '../handlers/pipeline/create_invoice.js'
import { handler as createAddon } from '../handlers/pipeline/create_addon.js'
import { handler as depositPaid } from '../handlers/pipeline/deposit_paid.js'
import { handler as issueFinalInvoice } from '../handlers/pipeline/issue_final_invoice.js'
import { handler as expansionInvoice } from '../handlers/pipeline/expansion_invoice.js'
import { handler as expansionInstall } from '../handlers/pipeline/expansion_install.js'
import { handler as setupProject } from '../handlers/pipeline/setup_project.js'
import { handler as onboarding } from '../handlers/pipeline/onboarding.js'

const router = Router()

router.all('/qualify', async (req, res) => { await qualify(req, res) })
router.all('/cal-webhook', async (req, res) => { await calWebhook(req, res) })
router.all('/convert_to_deal', async (req, res) => { await convertToDeal(req, res) })
router.all('/create_quotation', async (req, res) => { await createQuotation(req, res) })
router.all('/create_invoice', async (req, res) => { await createInvoice(req, res) })
router.all('/create_addon', async (req, res) => { await createAddon(req, res) })
router.all('/deposit_paid', async (req, res) => { await depositPaid(req, res) })
router.all('/issue_final_invoice', async (req, res) => { await issueFinalInvoice(req, res) })
router.all('/expansion_invoice', async (req, res) => { await expansionInvoice(req, res) })
router.all('/expansion_install', async (req, res) => { await expansionInstall(req, res) })
router.all('/setup_project', async (req, res) => { await setupProject(req, res) })
router.all('/onboarding', async (req, res) => { await onboarding(req, res) })

export default router