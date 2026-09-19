/**
 * Does rollup() computed CLIENT-SIDE agree with the server's /analytics?
 *
 * The run page computes metrics locally from the SSE stream so the numbers move
 * while a run is in flight, and the API serves the same metrics at
 * GET /runs/:id/analytics. That is only a saving if the two genuinely agree --
 * otherwise the canvas and the endpoint quietly disagree and nobody notices
 * until someone screenshots both.
 *
 * The inputs differ in origin, which is exactly why this is worth checking:
 *   server -> store.listSteps / listEgress / listScheduleDecisions
 *   client -> the SSE reducer's accumulated arrays
 *
 * Needs a running API in mock mode:
 *   MOCK_ALL=true pnpm dev:api
 *   pnpm --filter @htn/api check:analytics
 */

import { rollup, type RunAnalytics } from '@htn/shared';

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
  const server = await api<RunAnalytics>('/api/runs/' + runId + '/analytics');

  // Our own, from the same raw entities the client accumulates over SSE.
  const detail = await api<Parameters<typeof rollup>[0] & { piiSpans: unknown }>(
    '/api/runs/' + runId,
  );
  // `now` is irrelevant here: the run is finished, so every step has an endedAt
  // and spanMs never falls back to the clock. That is also why wallMs is safe
  // to compare exactly below -- on a LIVE run it would legitimately differ
  // between two invocations.
  const local = rollup(detail);

  console.log('\nTotals');
  const keys = [
    'tokensIn',
    'tokensOut',
    'llmCalls',
    'estimatedCostCents',
    'stepCount',
    'nodeCount',
    'approvals',
    'toolsAvailable',
    'toolsExposed',
  ] as const;

  for (const key of keys) {
    check(
      key + ' agrees',
      local.totals[key] === server.totals[key],
      local.totals[key] + ' local vs ' + server.totals[key] + ' server',
    );
  }

  console.log('\nPer node');
  check(
    'same set of nodes',
    local.nodes.length === server.nodes.length,
    local.nodes.length + ' vs ' + server.nodes.length,
  );

  for (const serverNode of server.nodes) {
    const localNode = local.nodes.find((n) => n.nodeId === serverNode.nodeId);
    check(
      serverNode.nodeId + ': tokens and calls agree',
      Boolean(localNode) &&
        localNode!.tokensIn === serverNode.tokensIn &&
        localNode!.tokensOut === serverNode.tokensOut &&
        localNode!.llmCalls === serverNode.llmCalls,
      localNode
        ? localNode.tokensIn +
            '/' +
            localNode.tokensOut +
            ' vs ' +
            serverNode.tokensIn +
            '/' +
            serverNode.tokensOut
        : 'missing locally',
    );
  }

  check(
    'wallMs agrees (finished run, so the clock is not consulted)',
    local.totals.wallMs === server.totals.wallMs,
    local.totals.wallMs + ' vs ' + server.totals.wallMs,
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
