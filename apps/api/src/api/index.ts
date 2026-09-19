/**
 * Route mounting. WRITTEN ONCE, fully populated — add a router here only when
 * you add a genuinely new resource. Keeping this file stable is what stops four
 * people conflicting on it.
 */

import type { Express } from 'express';
import { Router } from 'express';
import { approvalsRouter } from './approvals.routes.js';
import { providersRouter } from './providers.routes.js';
import { runsRouter } from './runs.routes.js';
import { streamRouter } from './stream.routes.js';

export function mountRoutes(app: Express): void {
  const api = Router();

  api.get('/health', (_req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
  });

  api.use(providersRouter);
  api.use(runsRouter);
  api.use(approvalsRouter);
  api.use(streamRouter);

  app.use('/api', api);
}
