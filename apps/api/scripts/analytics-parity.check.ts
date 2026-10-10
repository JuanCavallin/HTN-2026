/**
 * Does rollupV2() computed CLIENT-SIDE agree with the server's /analytics/v2?
 *
 * The run page computes metrics locally from the SSE stream so the numbers move
 * while a run is in flight, and the API serves the same metrics at
 * GET /runs/:id/analytics/v2. That is only a saving if the two genuinely agree --
 * otherwise the canvas and the endpoint quietly disagree and nobody notices
 * until someone screenshots both.
 *
 * Both sides rebuild from persisted StoredEvent[] so entity-table timing can
 * never make the endpoint and live UI disagree.
 *
 * Needs a running API in mock mode:
 *   MOCK_ALL=true pnpm dev:api
 *   pnpm --filter @htn/api check:analytics
 */

import {
  rollupV2,
  runViewFromStoredEvents,
  type RunAnalyticsV2,
  type StoredEvent,
} from '@htn/shared';

const BASE = process.env.PARITY_BASE ?? 'http://localhost:8787';

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures += 1;
  console.log(
    '  [' + (condition ? 'PASS' : 'FAIL') + '] ' + label + (detail ? ' -> ' + detail : ''),
  );
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return (await res.json()) as T;
}

async function waitFor(
  runId: string,
  predicate: (run: { status: string }) => boolean,
  timeoutMs = 90_000,
): Promise<Record<string, never> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await api<{ run?: { status: string } }>('/api/runs/' + runId);
    if (body.run && predicate(body.run)) return body as never;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function main(): Promise<void> {
  console.log('Analytics parity check against ' + BASE + '\n');

  const created = await api<{ run: { id: string } }>('/api/runs', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'graph',
      input: { graphId: 'graph_demo', variables: { target: 'PARITY-1' } },
    }),
  });
  const runId = created.run.id;

  const blocked = await waitFor(runId, (r) => r.status === 'awaiting_approval');
  check('run reached the approval gate', Boolean(blocked));
  if (!blocked) return finish();

  const pending = (
    blocked as unknown as { approvals: { id: string; status: string }[] }
  ).approvals.find((a) => a.status === 'pending');
  await api('/api/approvals/' + pending!.id + '/decide', {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved' }),
  });
  await waitFor(runId, (r) => r.status === 'succeeded' || r.status === 'failed');

  // Server's answer.
  const server = await api<RunAnalyticsV2>('/api/runs/' + runId + '/analytics/v2');

  // This is exactly what an SSE client receives and reduces. `now` is irrelevant
  // for a terminal run, so the complete contract must match byte-for-byte.
  const replay = await api<{ events: StoredEvent[] }>('/api/runs/' + runId + '/events');
  const local = rollupV2(runViewFromStoredEvents(replay.events));

  console.log('\nEvent-derived contract');
  check('V2 contract returned', server.version === 2);
  check('run identity agrees', local.runId === server.runId);
  check('run status agrees', local.status === server.status);
  check('usage agrees', JSON.stringify(local.usage) === JSON.stringify(server.usage));
  check('timing agrees', JSON.stringify(local.timing) === JSON.stringify(server.timing));
  check('tool funnel agrees', JSON.stringify(local.tools) === JSON.stringify(server.tools));
  check('approvals agree', JSON.stringify(local.approvals) === JSON.stringify(server.approvals));
  check('per-node metrics agree', JSON.stringify(local.nodes) === JSON.stringify(server.nodes));

  check(
    'model calls are lifecycle-counted',
    server.usage.modelCalls.agent ===
      new Set(
        replay.events.flatMap((stored) =>
          stored.event.type === 'model.lifecycle' ? [stored.event.lifecycle.modelCallId] : [],
        ),
      ).size,
  );

  const pollCount = replay.events.filter(
    (stored) =>
      stored.event.type === 'egress.logged' &&
      stored.event.egress.providerId === 'hermes' &&
      stored.event.egress.op === 'pollTask',
  ).length;
  check(
    'Hermes polling is not provider work',
    pollCount === 0 ||
      server.usage.otherProviders.calls <
        replay.events.filter((stored) => stored.event.type === 'egress.logged').length,
    pollCount + ' poll row(s)',
  );

  finish();
}

function finish(): void {
  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: Error) => {
  console.error('\nParity check crashed:', err.message);
  console.error('Is the API running?  MOCK_ALL=true pnpm dev:api');
  process.exit(1);
});
