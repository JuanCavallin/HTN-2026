/**
 * End-to-end smoke test. The only test in the repo, on purpose.
 *
 * Verifies the walking skeleton against a running API in mock mode:
 *   launch a run -> steps stream -> it BLOCKS on an approval -> approve ->
 *   it completes -> the egress ledger recorded the calls.
 *
 * Usage:  pnpm dev:api    (in one terminal)
 *         pnpm smoke      (in another)
 */

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:8787';

let failures = 0;

function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log('  [' + mark + '] ' + label + (detail ? ' -> ' + detail : ''));
}

async function api(path, init) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function waitFor(runId, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await api('/api/runs/' + runId);
    if (body?.run && predicate(body.run, body)) return body;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function main() {
  console.log('Smoke test against ' + BASE + '\n');

  console.log('1. Health and providers');
  const health = await api('/api/health');
  check('GET /api/health is 200', health.status === 200, JSON.stringify(health.body));

  const providers = await api('/api/providers');
  const list = providers.body?.providers ?? [];
  check('six providers reported', list.length === 6, list.length + ' found');
  check(
    'no provider is in live mode without a key',
    list.every((p) => p.mode !== 'live'),
    list.map((p) => p.id + '=' + p.mode).join(' '),
  );

  console.log('\n2. Launch a run');
  const created = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ kind: 'demo', input: {} }),
  });
  check('POST /api/runs is 201', created.status === 201, 'status ' + created.status);
  const runId = created.body?.run?.id;
  check('run id returned', Boolean(runId), runId ?? 'none');
  if (!runId) return;

  console.log('\n3. The risk gate blocks on the irreversible action');
  const blocked = await waitFor(runId, (run) => run.status === 'awaiting_approval');
  check('run reached awaiting_approval', Boolean(blocked), blocked?.run?.status ?? 'timed out');
  if (!blocked) return;

  const approval = blocked.approvals.find((a) => a.status === 'pending');
  check('a pending approval exists', Boolean(approval));
  check(
    'it was gated on reversibility, not model confidence',
    approval?.reversibility === 'irreversible' &&
      approval?.policyRule === 'irreversible-action-requires-approval',
    approval?.policyRule ?? 'none',
  );

  const swarmWorkers = blocked.steps.filter((s) => s.parentStepId !== null);
  check('swarm fanned out as child steps', swarmWorkers.length >= 3, swarmWorkers.length + ' workers');

  const agentTaskStep = blocked.steps.find((s) => s.kind === 'agent_task');
  check('agent task step ran', Boolean(agentTaskStep), agentTaskStep?.status ?? 'missing');
  check(
    'agent task step succeeded',
    agentTaskStep?.status === 'succeeded',
    agentTaskStep?.status ?? 'none',
  );

  const scheduleDecisions = blocked.scheduleDecisions ?? [];
  check(
    'a schedule decision was recorded',
    scheduleDecisions.length >= 1,
    scheduleDecisions.length + ' found',
  );
  const decision = scheduleDecisions[0];
  check(
    'Jev filtered the tool list before the agent runtime ran',
    Boolean(decision) && decision.exposedTools.length < decision.availableTools.length,
    decision
      ? decision.exposedTools.length + ' of ' + decision.availableTools.length
      : 'no decision',
  );
  check('the routing decision names the rule that produced it', Boolean(decision?.rule));
  check(
    'the routing decision is NOT gated on model confidence',
    !('riskClass' in (decision ?? {})),
  );

  check(
    'Hermes-internal tool calls were reported into the egress ledger post-hoc',
    blocked.egress.some((e) => e.policyRule === 'reported-post-hoc-by-hermes'),
  );

  check(
    'PII was detected and pinned locally',
    blocked.piiSpans.length >= 3,
    blocked.piiSpans.length + ' spans',
  );
  check(
    'no raw PII value crossed the wire',
    blocked.piiSpans.every((s) => !('value' in s) && s.routedTo === 'local'),
  );

  // Regression guard. A step's `output` is streamed and stored, so a playbook
  // that returns a raw document from a step leaks it to every connected client.
  // These are the exact values the demo case file contains.
  const wire = JSON.stringify(blocked);
  check(
    'no raw sensitive value appears anywhere in the client payload',
    !wire.includes('046 454 286') &&
      !wire.includes('avery.chen@example.edu') &&
      !wire.includes('519-555-0142'),
  );
  check('placeholders appear instead', wire.includes('[[PII_1]]'));

  console.log('\n4. Approve, and the run resumes');
  const decided = await api('/api/approvals/' + approval.id + '/decide', {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved' }),
  });
  check('POST decide is 200', decided.status === 200, 'status ' + decided.status);

  const done = await waitFor(runId, (run) => run.status === 'succeeded' || run.status === 'failed');
  check('run succeeded', done?.run?.status === 'succeeded', done?.run?.status ?? 'timed out');
  check('run produced a summary', Boolean(done?.run?.summary), done?.run?.summary ?? '');

  console.log('\n5. The egress ledger');
  const egress = await api('/api/runs/' + runId + '/egress');
  const events = egress.body?.events ?? [];
  check('ledger recorded provider calls', events.length > 0, events.length + ' rows');
  check(
    'every row names the rule that allowed it',
    events.every((e) => Boolean(e.policyRule)),
  );
  check(
    'the cloud model call carried placeholders, not values',
    events.some((e) => e.providerId === 'anthropic' && e.decision === 'redacted'),
  );
  check('summary reports zero raw values sent', egress.body?.summary?.rawValuesSent === 0);

  console.log('\n6. Rejection path');
  const second = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ kind: 'demo', input: { workerCount: 2 } }),
  });
  const secondId = second.body?.run?.id;
  const blocked2 = await waitFor(secondId, (run) => run.status === 'awaiting_approval');
  const approval2 = blocked2?.approvals.find((a) => a.status === 'pending');
  if (approval2) {
    await api('/api/approvals/' + approval2.id + '/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'rejected', note: 'smoke test' }),
    });
    const cancelled = await waitFor(
      secondId,
      (run) => run.status === 'cancelled' || run.status === 'failed',
    );
    check('rejecting stops the run', cancelled?.run?.status === 'cancelled', cancelled?.run?.status);
    const conflict = await api('/api/approvals/' + approval2.id + '/decide', {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved' }),
    });
    check('deciding twice is a 409', conflict.status === 409, 'status ' + conflict.status);
  } else {
    check('second run reached its approval', false, 'timed out');
  }

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err.message);
  console.error('Is the API running?  pnpm dev:api');
  process.exit(1);
});
