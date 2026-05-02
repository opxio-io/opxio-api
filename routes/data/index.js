import { Router } from 'express'

import { handler as accounts } from '../../handlers/data/accounts.js'
import { handler as catalogue_update } from '../../handlers/data/catalogue-update.js'
import { handler as catalogue } from '../../handlers/data/catalogue.js'
import { handler as deals } from '../../handlers/data/deals.js'
import { handler as finance_snapshot } from '../../handlers/data/finance-snapshot.js'
import { handler as finance } from '../../handlers/data/finance.js'
import { handler as forecast } from '../../handlers/data/forecast.js'
import { handler as internal_builds } from '../../handlers/data/internal-builds.js'
import { handler as meetings } from '../../handlers/data/meetings.js'
import { handler as pipeline } from '../../handlers/data/pipeline.js'
import { handler as progress } from '../../handlers/data/progress.js'
import { handler as projects } from '../../handlers/data/projects.js'
import { handler as settings_update } from '../../handlers/data/settings-update.js'
import { handler as settings } from '../../handlers/data/settings.js'
import { handler as team_tasks } from '../../handlers/data/team-tasks.js'

const router = Router()

router.all('/accounts', async (req, res) => { await accounts(req, res) })
router.all('/catalogue-update', async (req, res) => { await catalogue_update(req, res) })
router.all('/catalogue', async (req, res) => { await catalogue(req, res) })
router.all('/deals', async (req, res) => { await deals(req, res) })
router.all('/finance-snapshot', async (req, res) => { await finance_snapshot(req, res) })
router.all('/finance', async (req, res) => { await finance(req, res) })
router.all('/forecast', async (req, res) => { await forecast(req, res) })
router.all('/internal-builds', async (req, res) => { await internal_builds(req, res) })
router.all('/meetings', async (req, res) => { await meetings(req, res) })
router.all('/pipeline', async (req, res) => { await pipeline(req, res) })
router.all('/progress', async (req, res) => { await progress(req, res) })
router.all('/projects', async (req, res) => { await projects(req, res) })
router.all('/settings-update', async (req, res) => { await settings_update(req, res) })
router.all('/settings', async (req, res) => { await settings(req, res) })
router.all('/team-tasks', async (req, res) => { await team_tasks(req, res) })

export default router