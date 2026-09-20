/**
 * Route mounting. WRITTEN ONCE, fully populated — add a router here only when
 * you add a genuinely new resource. Keeping this file stable is what stops four
 * people conflicting on it.
 */

import type { Express } from 'express';
import { Router } from 'express';
import { approvalsRouter } from './approvals.routes.js';
import { graphsRouter } from './graphs.routes.js';
import { providersRouter } from './providers.routes.js';
import { runsRouter } from './runs.routes.js';
import { streamRouter } from './stream.routes.js';
import { toolsRouter } from './tools.routes.js';
import { modelGatewayRouter } from './modelGateway.routes.js';
import { mcpGatewayRouter } from './mcp.routes.js';
import { mcpConnectionsRouter } from './mcpConnections.routes.js';

export function mountRoutes(app: Express): void {
  const api = Router();

  api.get('/health', (_req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
  });

  api.use(providersRouter);
  api.use(graphsRouter);
  api.use(runsRouter);
  api.use(approvalsRouter);
  api.use(streamRouter);
  api.use(toolsRouter);
  api.use(mcpConnectionsRouter);

  // Hermes uses this OpenAI-compatible endpoint. It is intentionally outside
  // /api because SDK clients append /chat/completions to a /v1 base URL.
  app.use('/v1', modelGatewayRouter);
  app.use('/mcp', mcpGatewayRouter);
  app.use('/api', api);
}
