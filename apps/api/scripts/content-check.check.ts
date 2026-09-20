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

console.log(
  'PASS: outbound-text check escalates only, fails open on provider error, ' +
    'and never scores denied actions, reads, headers, or short strings.',
);
