import { Router } from 'express';
import {
  createRunRequestSchema,
  listRunsQuerySchema,
  rollup,
  type CreateRunRequest,
  type ListRunsQuery,
} from '@htn/shared';
import { providers } from '../services/runtime.js';
import {
  availablePlaybooks,
  cancelRun,
  createRun,
  getRunEvents,
  getRunDetail,
  listRuns,
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

/** JSON replay for debugging/export; live clients should use the SSE endpoint. */
runsRouter.get('/runs/:id/events', async (req, res) => {
  const rawSince = Number(req.query.since ?? 0);
  const since = Number.isFinite(rawSince) && rawSince > 0 ? rawSince : 0;
  const events = await getRunEvents(param(req, 'id'), since);
  if (!events) throw new HttpError(404, 'NOT_FOUND', 'Run not found');
  res.json({ events, lastSeq: events.at(-1)?.seq ?? since });
});

runsRouter.post('/runs/:id/cancel', async (req, res) => {
  const run = await cancelRun(param(req, 'id'));
  if (!run) throw new HttpError(404, 'NOT_FOUND', 'Run not found');
  res.json({ run });
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
/**
 * A CURRENT viewer URL for a browser session this run holds.
 *
 * Minted per request on purpose. Browserbase signs its debug URL with a
 * short-lived token, so the URL captured when the session opened is already
 * dead by the time a person clicks a handoff link -- it renders a blank page
 * that accepts no input. Never cache what this returns.
 *
 * 200 with `liveViewUrl: null` is a NORMAL answer, not an error: local and
 * mocked browsers have no viewer, and a session that has since closed cannot
 * produce one. The UI renders that state rather than a dead link.
 */
runsRouter.get('/runs/:id/browser/:sessionId/live-view', async (req, res) => {
  const runId = param(req, 'id');
  const sessionId = param(req, 'sessionId');

  const detail = await getRunDetail(runId);
  if (!detail) throw new HttpError(404, 'NOT_FOUND', 'Run not found');

  const adapter = providers.provider('browser');
  if (!adapter.liveView) {
    res.json({ liveViewUrl: null, interactive: false });
    return;
  }

  const result = await adapter.liveView(sessionId, {
    runId,
    policyRule: 'handoff-live-view-refresh',
  });

  res.json(
    result.ok
      ? {
          liveViewUrl: result.data.liveViewUrl ?? null,
          // 'about:blank' here means the session is open but nothing is loaded
          // -- almost always an `open` node with no url. The UI says so rather
          // than handing over a white box.
          pageUrl: result.data.pageUrl ?? null,
          interactive: result.data.interactive,
        }
      : { liveViewUrl: null, pageUrl: null, interactive: false },
  );
});

runsRouter.get('/runs/:id/analytics', async (req, res) => {
  const detail = await getRunDetail(param(req, 'id'));
  if (!detail) throw new HttpError(404, 'NOT_FOUND', 'Run not found');
  res.json(rollup(detail));
});
