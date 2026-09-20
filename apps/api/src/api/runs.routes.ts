import { Router } from 'express';
import {
  createRunRequestSchema,
  listRunsQuerySchema,
  rollup,
  type CreateRunRequest,
  type ListRunsQuery,
} from '@htn/shared';
import {
  availablePlaybooks,
  cancelRun,
  createRun,
  getRunDetail,
  listRuns,
  probeStaleRuns,
  saveRunAsGraph,
} from '../services/runs.service.js';
import { listEgress } from '../services/egress.service.js';
import { HttpError, param, valid, validate } from './middleware/validate.js';

export const runsRouter: Router = Router();

/** The launch form reads this to know what can be run. */
runsRouter.get('/playbooks', (_req, res) => {
  res.json({ playbooks: availablePlaybooks() });
});

runsRouter.get('/runs', validate(listRunsQuerySchema, 'query'), async (req, res) => {
  const query = valid<ListRunsQuery>(req, 'query');
  res.json({ runs: await listRuns(query) });
});

runsRouter.post('/runs', validate(createRunRequestSchema), async (req, res) => {
  const body = valid<CreateRunRequest>(req, 'body');
  // Returns as soon as the run is persisted. Execution continues in the
  // background and is observed over SSE.
  const run = await createRun({ kind: body.kind, input: body.input, title: body.title });
  res.status(201).json({ run });
});

runsRouter.get('/runs/:id', async (req, res) => {
  const detail = await getRunDetail(param(req, 'id'));
  if (!detail) throw new HttpError(404, 'NOT_FOUND', 'Run not found');
  res.json(detail);
});

runsRouter.post('/runs/:id/cancel', async (req, res) => {
  const run = await cancelRun(param(req, 'id'));
  if (!run) throw new HttpError(404, 'NOT_FOUND', 'Run not found');
  res.json({ run });
});

/**
 * Cancel every non-terminal run this process isn't actually executing --
 * debris from a restart, a crash, or a deliberately-killed process. Also run
 * automatically at boot; exposed here for an on-demand sweep without one.
 */
runsRouter.post('/runs/probe-stale', async (_req, res) => {
  res.json(await probeStaleRuns());
});

/** "Save as a new task" -- fork the graph THIS run executed into a new document. */
runsRouter.post('/runs/:id/save-as-graph', async (req, res) => {
  const graph = await saveRunAsGraph(param(req, 'id'));
  if (!graph) throw new HttpError(404, 'NOT_FOUND', 'Run not found');
  res.status(201).json({ graph });
});

runsRouter.get('/runs/:id/egress', async (req, res) => {
  res.json(await listEgress(param(req, 'id')));
});

/**
 * Per-node and total tokens, time and cost.
 *
 * getRunDetail already returns exactly rollup()'s inputs, and rollup lives in
 * @htn/shared so the web app runs the SAME function over the SSE stream for
 * live numbers. One implementation, two callers.
 */
runsRouter.get('/runs/:id/analytics', async (req, res) => {
  const detail = await getRunDetail(param(req, 'id'));
  if (!detail) throw new HttpError(404, 'NOT_FOUND', 'Run not found');
  res.json(rollup(detail));
});
