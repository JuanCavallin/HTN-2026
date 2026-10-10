/**
 * Focused event-projection checks for the metrics endpoint.
 *
 * The richer metric assertions are intentionally below this projection setup:
 * both exercise the same persisted history so a future endpoint cannot quietly
 * return to querying independent entity tables.
 */

import assert from 'node:assert/strict';
import {
  rollupV2,
  runViewFromStoredEvents,
  type ModelLifecycleEvent,
  type Run,
  type RunEvent,
  type Step,
  type StoredEvent,
} from '@htn/shared';

const startedRun: Run = {
  id: 'run_metrics_check',
  kind: 'graph',
  title: 'Metrics check',
  status: 'running',
  input: {},
  createdAt: '2026-09-22T12:00:00.000Z',
  updatedAt: '2026-09-22T12:00:00.000Z',
};

const finishedRun: Run = {
  ...startedRun,
  status: 'succeeded',
  updatedAt: '2026-09-22T12:00:03.000Z',
};

const runningStep: Step = {
  id: 'step_metrics_check',
  runId: startedRun.id,
  parentStepId: null,
  seq: 1,
  nodeId: 'agent',
  kind: 'agent_task',
  label: 'Do work',
  status: 'running',
  startedAt: '2026-09-22T12:00:00.100Z',
};

const finishedStep: Step = {
  ...runningStep,
  status: 'succeeded',
  endedAt: '2026-09-22T12:00:02.500Z',
};

function modelLifecycle(
  id: string,
  phase: ModelLifecycleEvent['phase'],
  details: Partial<ModelLifecycleEvent> = {},
): ModelLifecycleEvent {
  return {
    id,
    modelCallId: 'model_call_1',
    runId: startedRun.id,
    stepId: runningStep.id,
    sessionStateId: 'session_metrics_check',
    phase,
    routeId: 'openrouter:cheap',
    providerId: 'openrouter',
    configuredModelId: 'openai/gpt-4.1-mini',
    selectedToolIds: ['gmail.send'],
    dataLabels: ['public'],
    messageCount: 2,
    at: phase === 'requested' ? '2026-09-22T12:00:00.200Z' : '2026-09-22T12:00:01.200Z',
    ...details,
  };
}

function stored(seq: number, event: RunEvent): StoredEvent {
  return {
    seq,
    runId: startedRun.id,
    event,
    at: '2026-09-22T12:00:00.000Z',
  };
}

// Deliberately shuffled: the durable sequence, not caller array order, is the
// history authority.
const history: StoredEvent[] = [
  stored(10, { type: 'run.updated', run: finishedRun }),
  stored(2, { type: 'step.upserted', step: runningStep }),
  stored(1, { type: 'run.updated', run: startedRun }),
  stored(9, { type: 'step.upserted', step: finishedStep }),
  stored(3, {
    type: 'model.lifecycle',
    lifecycle: modelLifecycle('model_event_requested', 'requested'),
  }),
  stored(4, {
    type: 'egress.logged',
    egress: {
      id: 'egress_poll',
      runId: startedRun.id,
      stepId: runningStep.id,
      at: '2026-09-22T12:00:00.500Z',
      providerId: 'hermes',
      op: 'pollTask',
      destination: 'hermes-acp://local',
      dataSpans: [],
      policyRule: 'jev-filtered-toolset',
      decision: 'allowed',
      latencyMs: 5,
    },
  }),
  stored(5, {
    type: 'model.lifecycle',
    lifecycle: modelLifecycle('model_event_completed', 'completed', {
      actualModelId: 'openai/gpt-4.1-mini-2026-08-01',
      latencyMs: 1_000,
      tokensIn: 100,
      tokensOut: 25,
      estimatedCostCents: 0.2,
      toolCallCount: 1,
    }),
  }),
  stored(6, {
    type: 'egress.logged',
    egress: {
      id: 'egress_model',
      runId: startedRun.id,
      stepId: runningStep.id,
      at: '2026-09-22T12:00:01.200Z',
      providerId: 'openrouter',
      op: 'chat',
      destination: 'https://openrouter.ai/api/v1/chat/completions',
      dataSpans: [],
      policyRule: 'model-gateway-route',
      decision: 'allowed',
      latencyMs: 1_000,
      tokensIn: 100,
      tokensOut: 25,
      estimatedCostCents: 0.2,
    },
  }),
  stored(7, {
    type: 'control.decided',
    decision: {
      id: 'control_select_model',
      runId: startedRun.id,
      stepId: runningStep.id,
      operation: 'select_model',
      candidateIds: ['openrouter:cheap', 'ollama:local'],
      selectedIds: ['openrouter:cheap'],
      confidence: 0.91,
      reasonCodes: ['jev-model-selection'],
      source: 'jev',
      at: '2026-09-22T12:00:00.150Z',
    },
  }),
  stored(8, {
    type: 'egress.logged',
    egress: {
      id: 'egress_jev',
      runId: startedRun.id,
      stepId: runningStep.id,
      at: '2026-09-22T12:00:00.150Z',
      providerId: 'jev',
      op: 'select_model',
      destination: 'https://ai-gateway.vercel.sh/v1/evaluation-model',
      dataSpans: [],
      policyRule: 'model-route-selection',
      decision: 'allowed',
      tokensIn: 12,
      tokensOut: 2,
      // Jev pricing is unknown. Omitting cost must remain unknown, not $0.
    },
  }),
];

const originalOrder = history.map((event) => event.seq);
const view = runViewFromStoredEvents(history);

assert.equal(view.run?.status, 'succeeded', 'latest run event wins');
assert.equal(view.steps.length, 1, 'step lifecycle is upserted rather than double-counted');
assert.equal(view.steps[0]?.status, 'succeeded', 'latest step event wins');
assert.equal(view.modelCalls.length, 2, 'each model lifecycle phase remains available');
assert.equal(view.egress.length, 3, 'the complete privacy ledger remains available');
assert.equal(view.lastSeq, 10, 'projection retains the replay cursor');
assert.deepEqual(
  history.map((event) => event.seq),
  originalOrder,
  'projection does not reorder its caller-owned event array',
);

const metrics = rollupV2(view, Date.parse('2026-09-22T12:00:03.000Z'));
assert.equal(metrics.version, 2);
assert.equal(metrics.source, 'event_ledger');
assert.equal(metrics.lastSeq, 10);
assert.equal(metrics.usage.modelCalls.agent, 1, 'model lifecycle phases count as one logical call');
assert.equal(
  metrics.usage.modelCalls.jev,
  1,
  'an observed Jev provider call is counted separately',
);
assert.equal(metrics.usage.agentModels.calls, 1);
assert.equal(metrics.usage.agentModels.totalTokens.value, 125);
assert.equal(metrics.usage.agentModels.totalTokens.coverage.complete, true);
assert.equal(metrics.usage.agentModels.estimatedCostCents.value, 0.2);
assert.equal(metrics.usage.jev.totalTokens.value, 14);
assert.equal(metrics.usage.jev.estimatedCostCents.value, null, 'missing Jev cost is not zero');
assert.equal(metrics.usage.total.estimatedCostCents.value, 0.2);
assert.equal(
  metrics.usage.total.estimatedCostCents.coverage.complete,
  false,
  'partial cost totals expose incomplete coverage',
);
assert.equal(
  metrics.usage.otherProviders.calls,
  0,
  'Hermes pollTask is retained in egress but excluded from provider work',
);
assert.equal(
  metrics.timing.providerLatencyMs.value,
  1_000,
  'Hermes pollTask does not inflate provider-work latency',
);
assert.equal(
  metrics.timing.pausedMs.value,
  null,
  'legacy runs without pause coverage do not claim zero pause time',
);
assert.equal(
  metrics.timing.activeExecutionMs.value,
  null,
  'active time stays unknown when legacy pause coverage is missing',
);

const completePauseCoverage = rollupV2({
  ...view,
  run: view.run ? { ...view.run, pauses: [] } : null,
});
assert.equal(completePauseCoverage.timing.pausedMs.value, 0);
assert.equal(
  completePauseCoverage.timing.activeExecutionMs.value,
  2_400,
  'an explicit empty pause ledger makes active execution time measurable',
);

console.log(
  'PASS: persisted events project deterministically and produce lifecycle-derived metrics.',
);
