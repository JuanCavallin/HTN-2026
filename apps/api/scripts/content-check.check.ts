/**
 * Proves the one property that makes the outbound-text check safe to ship:
 * IT CAN ONLY ESCALATE.
 *
 * A content score is evidence about text, never authorization to act, so this
 * exercises every direction it could go wrong in:
 *   - a machine-sounding body escalates an unattended send to a human
 *   - a human-sounding body changes nothing
 *   - a GPTZero outage changes nothing (fail open, by design)
 *   - a scored 'deny' stays denied and is never even sent for scoring
 *   - a read-only tool and a short string never spend a call
 */

import assert from 'node:assert/strict';
import type {
  ContentAnalysisAdapter,
  ProviderResult,
  ToolAction,
  ToolDescriptor,
} from '@htn/shared';
import { checkOutboundText, outboundTextOf } from '../src/core/tools/contentCheck.js';

const ctx = { runId: 'run_check', stepId: 'step_check', policyRule: 'check' };

/** Long enough to clear the min-length floor in every case below. */
const MACHINE_BODY =
  'Thank you for reaching out regarding this matter. I wanted to follow up and ' +
  'provide some additional context that may be helpful for your consideration.';
const SHORT_BODY = 'ok thanks';

function analysisReturning(score: number, label: string): ContentAnalysisAdapter {
  return {
    id: 'gptzero',
    mode: 'mock',
    capabilities: ['content.analysis'],
    async health() {
      return { ok: true, data: {}, meta: m('health') } as ProviderResult<{ detail?: string }>;
    },
    async analyze() {
      return { ok: true, data: { score, label }, meta: m('analyze') };
    },
    async invoke() {
      throw new Error('unused');
    },
  } as unknown as ContentAnalysisAdapter;
}

function analysisFailing(): ContentAnalysisAdapter {
  return {
    id: 'gptzero',
    mode: 'mock',
    capabilities: ['content.analysis'],
    async health() {
      return { ok: true, data: {}, meta: m('health') } as ProviderResult<{ detail?: string }>;
    },
    async analyze() {
      return {
        ok: false,
        error: { code: 'UPSTREAM', message: 'simulated outage', retryable: true },
        meta: m('analyze'),
      };
    },
    async invoke() {
      throw new Error('unused');
    },
  } as unknown as ContentAnalysisAdapter;
}

function m(op: string) {
  return { provider: 'gptzero', op, mode: 'mock', latencyMs: 0, destination: 'mock://gptzero' };
}

/** Counts calls so "never spend a call" is asserted, not assumed. */
function counting(inner: ContentAnalysisAdapter): {
  adapter: ContentAnalysisAdapter;
  calls: () => number;
} {
  let calls = 0;
  return {
    adapter: {
      ...inner,
      async analyze(input, callCtx) {
        calls += 1;
        return inner.analyze(input, callCtx);
      },
    } as ContentAnalysisAdapter,
    calls: () => calls,
  };
}

const MAIL_DESCRIPTOR = {
  id: 'mail.send',
  baselineEffect: 'write',
  reversibility: 'irreversible',
} as unknown as ToolDescriptor;

const READ_DESCRIPTOR = {
  id: 'mail.send',
  baselineEffect: 'read',
  reversibility: 'reversible',
} as unknown as ToolDescriptor;

function mailAction(body: string): ToolAction {
  return {
    id: 'act_check',
    runId: ctx.runId,
    stepId: ctx.stepId,
    toolId: 'mail.send',
    descriptorVersion: '1',
    operation: 'mail.send',
    arguments: { to: 'someone@example.com', subject: 'Hello', body },
    destination: 'https://gmail.example',
    dataLabels: ['public'],
    createdAt: new Date().toISOString(),
  } as ToolAction;
}

// --- the field allowlist only reads prose, never headers ----------------------
{
  const text = outboundTextOf(mailAction(MACHINE_BODY));
  assert.equal(text, MACHINE_BODY, 'only the body should be scored');
  assert.ok(!text.includes('someone@example.com'), 'recipient must never be scored');
  assert.ok(!text.includes('Hello'), 'subject must never be scored');
}

// --- machine-sounding text escalates an unattended send ----------------------
{
  const result = await checkOutboundText(
    analysisReturning(0.97, 'ai'),
    mailAction(MACHINE_BODY),
    MAIL_DESCRIPTOR,
    'auto',
    ctx,
  );
  assert.equal(result.outcome, 'escalated');
  assert.equal(result.policy, 'ask_user', 'auto must escalate to ask_user');
  assert.ok(result.reasonCodes.includes('outbound_text_reads_machine_written'));
}

// --- human-sounding text leaves the policy exactly as it was -----------------
{
  const result = await checkOutboundText(
    analysisReturning(0.03, 'human'),
    mailAction(MACHINE_BODY),
    MAIL_DESCRIPTOR,
    'auto',
    ctx,
  );
  assert.equal(result.outcome, 'passed');
  assert.equal(result.policy, 'auto', 'a passing score must never weaken or change policy');
}

// --- THE CORE INVARIANT: it can never hand back a weaker policy --------------
{
  for (const policy of ['auto', 'verify', 'ask_user', 'deny'] as const) {
    // Even a confidently-human score must not relax anything.
    const passed = await checkOutboundText(
      analysisReturning(0.0, 'human'),
      mailAction(MACHINE_BODY),
      MAIL_DESCRIPTOR,
      policy,
      ctx,
    );
    assert.equal(passed.policy, policy, 'a human score must not weaken ' + policy);

    // And an escalating score must not weaken a policy already stricter.
    const escalated = await checkOutboundText(
      analysisReturning(1.0, 'ai'),
      mailAction(MACHINE_BODY),
      MAIL_DESCRIPTOR,
      policy,
      ctx,
    );
    const rank = { auto: 0, verify: 1, ask_user: 2, deny: 3 } as const;
    assert.ok(
      rank[escalated.policy] >= rank[policy],
      'escalation must never move ' + policy + ' backwards (got ' + escalated.policy + ')',
    );
  }
}

// --- a provider outage is advisory, not a block (fail open, recorded) --------
{
  const result = await checkOutboundText(
    analysisFailing(),
    mailAction(MACHINE_BODY),
    MAIL_DESCRIPTOR,
    'auto',
    ctx,
  );
  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.policy, 'auto', 'an outage must not block an authorized send');
  assert.ok(
    result.reasonCodes.includes('content_check_unavailable'),
    'the trace must say the check did not run, not that the text passed',
  );
  assert.equal(result.score, undefined, 'no score may be reported when none was obtained');
}

// --- denied actions are never scored ----------------------------------------
{
  const probe = counting(analysisReturning(1.0, 'ai'));
  const result = await checkOutboundText(
    probe.adapter,
    mailAction(MACHINE_BODY),
    MAIL_DESCRIPTOR,
    'deny',
    ctx,
  );
  assert.equal(result.outcome, 'skipped');
  assert.equal(result.policy, 'deny');
  assert.equal(probe.calls(), 0, 'a denied action must not spend a GPTZero call');
}

// --- reads and short strings are never scored -------------------------------
{
  const readProbe = counting(analysisReturning(1.0, 'ai'));
  const read = await checkOutboundText(
    readProbe.adapter,
    mailAction(MACHINE_BODY),
    READ_DESCRIPTOR,
    'auto',
    ctx,
  );
  assert.equal(read.outcome, 'skipped', 'a read writes nothing in the user name');
  assert.equal(readProbe.calls(), 0);

  const shortProbe = counting(analysisReturning(1.0, 'ai'));
  const short = await checkOutboundText(
    shortProbe.adapter,
    mailAction(SHORT_BODY),
    MAIL_DESCRIPTOR,
    'auto',
    ctx,
  );
  assert.equal(short.outcome, 'skipped', 'text below the floor is not scoreable');
  assert.equal(shortProbe.calls(), 0, 'short text must not spend a call');
}

// =============================================================================
// INTEGRATION: the same rules, through the REAL ToolBroker.
//
// Everything above tests the checker in isolation. That proves the logic and
// nothing about whether it is actually wired, so this drives a real broker with
// a real authorization path and asserts the OBSERVABLE consequence: an action
// the gate cleared for 'auto' stops at the approval gate instead of executing.
// =============================================================================

{
  const { RunBus } = await import('../src/core/bus.js');
  const { DecisionService } = await import('../src/core/decisions/service.js');
  const { ToolBroker } = await import('../src/core/tools/broker.js');
  const { InMemoryToolExecutorRegistry } = await import('../src/core/tools/executors.js');
  const { InMemoryToolRegistry } = await import('../src/core/tools/registry.js');
  const { SessionStateService } = await import('../src/core/sessions/service.js');
  const { createMemoryStore } = await import('../src/store/memory.js');

  const store = createMemoryStore();
  const bus = new RunBus((runId, event) => store.appendEvent(runId, event));

  // Captured off the bus rather than read back from the store, because the bus
  // is what the dashboard actually subscribes to.
  const seen: { runId: string; event: { type: string; [k: string]: unknown } }[] = [];
  bus.subscribeAll((stored) => {
    seen.push({ runId: stored.runId, event: stored.event as never });
  });
  const sessions = new SessionStateService(store, bus);

  // A decision layer that always says 'auto' — so any stop MUST come from the
  // content check and cannot be the risk gate doing it anyway.
  const decisions = new DecisionService({
    id: 'jev',
    mode: 'mock',
    capabilities: ['decision'],
    async recommendActionPolicy() {
      return {
        ok: true,
        data: {
          policy: 'auto',
          confidence: 0.99,
          probabilities: { auto: 0.99 },
          reasonCodes: ['test-auto'],
        },
        meta: {
          provider: 'jev',
          op: 'recommendActionPolicy',
          mode: 'mock',
          latencyMs: 0,
          destination: 'mock://jev',
        },
      };
    },
  } as never);

  const descriptor = {
    id: 'mail.send',
    version: '1',
    providerId: 'check',
    family: 'mail',
    description: 'Send one email.',
    inputSchemaRef: 'agentos://schemas/mail.send/1',
    transport: 'mcp',
    baselineEffect: 'write',
    reversibility: 'recoverable',
    requiredScopes: [],
    allowedDataLabels: ['public'],
    availability: 'available',
    executorRef: 'check://mail.send',
  } as unknown as ToolDescriptor;

  const registry = new InMemoryToolRegistry();
  registry.register({
    descriptor,
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
      required: ['to', 'body'],
      additionalProperties: false,
    },
  });

  let executions = 0;
  const executors = new InMemoryToolExecutorRegistry();
  executors.register({
    ref: 'check://mail.send',
    destinationFor({ arguments: a }) {
      const args = a as { to?: string };
      return typeof args.to === 'string' ? 'mailto:' + args.to : undefined;
    },
    async execute() {
      executions += 1;
      // `verified` because the deterministic risk gate assigns 'verify' to an
      // unapproved write; without it the broker fails the action for reasons
      // that have nothing to do with the content check.
      return { output: {}, summary: 'sent', dataLabels: ['public'], verified: true };
    },
  });

  const approvalsRequested: string[] = [];
  const approvalGate = {
    async request({ action }: { action: ToolAction }) {
      approvalsRequested.push(action.id);
      return { approvalId: 'apr_content_1' };
    },
  };

  async function send(analysis: ContentAnalysisAdapter, body: string, runId: string) {
    const broker = new ToolBroker(registry, executors, decisions, sessions, bus, {
      approvalGate: approvalGate as never,
      contentCheck: { analysis },
    });
    const state = await sessions.create({
      runId,
      stepId: runId + '_step',
      harness: 'hermes',
      objective: 'Send an email.',
      sanitizedObjective: 'Send an email.',
      dataLabels: ['public'],
      budget: { stepsRemaining: 2 },
    });
    await sessions.beginTurn(state.id);
    await sessions.grantToolExposure(state.id, {
      modelCallId: 'chatcmpl_' + runId,
      selectedToolVersions: { 'mail.send': '1' },
    });
    return broker.execute({
      sessionStateId: state.id,
      toolId: 'mail.send',
      arguments: { to: 'alex@example.com', subject: 'Hi', body },
    });
  }

  // Machine-sounding body: the gate said auto, so a human prompt proves the
  // check is wired into the real execution path.
  const escalated = await send(analysisReturning(0.98, 'ai'), MACHINE_BODY, 'run_escalate');
  assert.equal(escalated.authorization.finalPolicy, 'ask_user', 'broker must adopt the escalation');
  assert.equal(approvalsRequested.length, 1, 'the approval gate must actually have been asked');
  assert.equal(escalated.approvalId, 'apr_content_1');
  assert.ok(
    escalated.authorization.reasonCodes.includes('outbound_text_reads_machine_written'),
    'the reason must survive onto the authorization the trace records',
  );
  assert.equal(executions, 1, 'it still executes once approved, it does not block');

  // Human-sounding body: no human prompt added, and it executes unattended.
  const before = executions;
  const passed = await send(analysisReturning(0.02, 'human'), MACHINE_BODY, 'run_pass');
  assert.notEqual(
    passed.authorization.finalPolicy,
    'ask_user',
    'a passing score must not add friction',
  );
  assert.equal(approvalsRequested.length, 1, 'no new approval may be requested');
  assert.equal(executions, before + 1, 'it must still send');

  // Outage: unchanged, still sends. The advisory component cannot block.
  const degraded = await send(analysisFailing(), MACHINE_BODY, 'run_outage');
  assert.notEqual(
    degraded.authorization.finalPolicy,
    'ask_user',
    'an outage must not escalate a permitted send',
  );
  assert.equal(approvalsRequested.length, 1, 'an outage must not request approval');
  assert.equal(executions, before + 2, 'an outage must not block the send');

  // And the trace carries the decision for the UI to render.
  const decision = seen.find(
    (entry) =>
      entry.runId === 'run_escalate' &&
      entry.event.type === 'control.decided' &&
      (entry.event.decision as { operation?: string }).operation === 'check_outbound_text',
  );
  assert.ok(decision, 'the outbound-text decision must reach the event stream');
  const record = decision.event.decision as { selectedIds: string[]; reasonCodes: string[] };
  assert.deepEqual(record.selectedIds, ['escalated']);
  assert.ok(record.reasonCodes.includes('outbound_text_reads_machine_written'));

  // A run whose check merely passed must still be traceable as HAVING RUN —
  // silence would be indistinguishable from the check being disabled.
  assert.ok(
    seen.some(
      (entry) =>
        entry.runId === 'run_pass' &&
        entry.event.type === 'control.decided' &&
        (entry.event.decision as { operation?: string }).operation === 'check_outbound_text',
    ),
    'a passing check must still be recorded',
  );
}

console.log(
  'PASS: outbound-text check escalates only, fails open on provider error, ' +
    'never scores denied actions, reads, headers, or short strings, ' +
    'and escalates a real ToolBroker execution to the approval gate.',
);
