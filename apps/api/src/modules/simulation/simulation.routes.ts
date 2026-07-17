/**
 * Simulation routes — DEV-ONLY. Mounted by `register()` only when ENABLE_SIMULATION is
 * set (and never in production), and additionally guarded by the admin shared secret.
 * Lets a developer seed a synthetic population and watch the trust/shadow systems react.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAdmin, config, logger } from '@trustroute/core';
import { z } from 'zod';
import * as sim from './simulation.service';

const setupBody = z.object({
  count: z.number().int().min(1).max(2000).default(100),
  seed: z.number().int().default(1),
  spammerRatio: z.number().min(0).max(1).default(0.15),
});
const generateBody = z.object({ seed: z.number().int().default(1) });

const router = Router();
router.use(requireAdmin);

router.post('/setup', validate({ body: setupBody }), asyncHandler(async (req, res) => {
  sendOk(res, await sim.setup(req.valid.body as z.infer<typeof setupBody>), { status: 201 });
}));

router.post('/generate', validate({ body: generateBody }), asyncHandler(async (req, res) => {
  sendOk(res, await sim.generate((req.valid.body as z.infer<typeof generateBody>).seed));
}));

router.post('/recompute', asyncHandler(async (_req, res) => sendOk(res, await sim.recompute())));

router.post('/run', validate({ body: setupBody }), asyncHandler(async (req, res) => {
  sendOk(res, await sim.run(req.valid.body as z.infer<typeof setupBody>));
}));

router.get('/state', asyncHandler(async (_req, res) => sendOk(res, await sim.state())));

router.delete('/teardown', asyncHandler(async (_req, res) => sendOk(res, await sim.teardown())));

export function register(app: Express): void {
  if (!config.ENABLE_SIMULATION || config.isProd) return; // dev-only, opt-in
  app.use('/simulation', router);
  logger.warn('simulation', 'DEV simulation module mounted at /simulation (ENABLE_SIMULATION=on)');
}
