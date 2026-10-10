import assert from 'node:assert/strict';
import {
  rollupV2,
  runViewFromStoredEvents,
  type RunEvent,
  type StoredEvent,
  type ToolAction,
} from '../src/index.js';

const at = (seconds: number): string => new Date(seconds * 1_000).toISOString();
const stored = (seq: number, event: RunEvent): StoredEvent => ({
  seq,
  runId: 'run_1',
  event,
  at: at(seq),
});

const action: ToolAction = {
  id: 'act_1',
  runId: 'run_1',
  stepId: 'step_1',
  toolId: 'gmail.send',
  descriptorVersion: '1',
  operation: 'send',
  arguments: {},
  dataLabels: ['private'],
  createdAt: at(3),
};

const events: StoredEvent[] = [
  stored(1, {
    type: 'run.updated',
    run: {
      id: 'run_1',
      kind: 'agent',
      title: 'Metrics check',
      status: 'succeeded',
      input: {},
      pauses: [{ at: at(1), resumedAt: at(2) }],
      createdAt: at(0),
      updatedAt: at(10),
    },
  }),
  stored(2, {
    type: 'step.upserted',
    step: {
      id: 'step_1',
      runId: 'run_1',
      parentStepId: null,
      nodeId: 'node_1',
      seq: 1,
      kind: 'agent_task',
      label: 'Agent',
      status: 'succeeded',
      startedAt: at(0.5),
      endedAt: at(9.5),
    },
  }),
  stored(3, {
    type: 'approval.requested',
    approval: {
      id: 'approval_1',
      runId: 'run_1',
      stepId: 'step_1',
      question: 'Send?',
      proposedAction: {},
      reversibility: 'irreversible',
      riskClass: 'ask_human',
      policyRule: 'outbound',
      status: 'approved',
      createdAt: at(3),
      decidedAt: at(5),
    },
  }),
  stored(4, {
    type: 'model.lifecycle',
    lifecycle: {
      id: 'model_requested',
      modelCallId: 'call_1',
      runId: 'run_1',
      stepId: 'step_1',
      sessionStateId: 'session_1',
      phase: 'requested',
      routeId: 'cloud',
      providerId: 'openrouter',
      configuredModelId: 'example/model',
      selectedToolIds: [],
      dataLabels: ['public'],
      messageCount: 1,
      at: at(2),
    },
  }),
  stored(5, {
    type: 'model.lifecycle',
    lifecycle: {
      id: 'model_completed',
      modelCallId: 'call_1',
      runId: 'run_1',
      stepId: 'step_1',
      sessionStateId: 'session_1',
      phase: 'completed',
      routeId: 'cloud',
      providerId: 'openrouter',
      configuredModelId: 'example/model',
      selectedToolIds: [],
      dataLabels: ['public'],
      messageCount: 1,
      at: at(3),
    },
  }),
  stored(6, {
    type: 'model.lifecycle',
    lifecycle: {
      id: 'model_failed',
      modelCallId: 'call_2',
      runId: 'run_1',
      stepId: 'step_1',
      sessionStateId: 'session_1',
      phase: 'failed',
      routeId: 'local',
      providerId: 'ollama',
      configuredModelId: 'qwen',
      selectedToolIds: [],
      dataLabels: ['private'],
      messageCount: 1,
      at: at(4),
    },
  }),
  stored(7, {
    type: 'control.decided',
    decision: {
      id: 'decision_1',
      runId: 'run_1',
      stepId: 'step_1',
      operation: 'select_tools',
      candidateIds: ['gmail.read', 'gmail.send', 'gmail.search'],
      selectedIds: ['gmail.send'],
      confidence: 0.9,
      reasonCodes: [],
      source: 'jev',
      at: at(2),
    },
  }),
  stored(8, {
    type: 'egress.logged',
    egress: {
      id: 'egress_agent',
      runId: 'run_1',
      stepId: 'step_1',
      at: at(3),
      providerId: 'openrouter',
      op: 'chat.completions',
      destination: 'https://openrouter.ai',
      dataSpans: [],
      policyRule: 'allowed',
      decision: 'allowed',
      latencyMs: 1_000,
      tokensIn: 100,
      tokensOut: 20,
      estimatedCostCents: 0.2,
    },
  }),
  stored(9, {
    type: 'egress.logged',
    egress: {
      id: 'egress_jev',
      runId: 'run_1',
      stepId: 'step_1',
      at: at(3),
      providerId: 'jev',
      op: 'select_tools',
      destination: 'https://gateway.ai.vercel.com',
      dataSpans: [],
      policyRule: 'allowed',
      decision: 'allowed',
      latencyMs: 50,
      tokensIn: 10,
      tokensOut: 2,
    },
  }),
  stored(10, {
    type: 'egress.logged',
    egress: {
      id: 'egress_tool',
      runId: 'run_1',
      stepId: 'step_1',
      at: at(6),
      providerId: 'composio',
      op: 'execute',
      destination: 'https://backend.composio.dev',
      dataSpans: [],
      policyRule: 'allowed',
      decision: 'allowed',
      latencyMs: 200,
    },
  }),
  stored(11, {
    type: 'egress.logged',
    egress: {
      id: 'egress_poll',
      runId: 'run_1',
      stepId: 'step_1',
      at: at(7),
      providerId: 'hermes',
      op: 'pollTask',
      destination: 'hermes-acp://local',
      dataSpans: [],
      policyRule: 'allowed',
      decision: 'allowed',
      latencyMs: 5,
    },
  }),
  ...(['proposed', 'executing', 'succeeded'] as const).map((phase, offset) =>
    stored(12 + offset, {
      type: 'tool.lifecycle',
      lifecycle: {
        id: `tool_${phase}`,
        runId: 'run_1',
        stepId: 'step_1',
        sessionStateId: 'session_1',
        phase,
        action,
        at: at(6 + offset),
      },
    }),
  ),
];

// A replayed frame must not duplicate facts.
events.push(events[7]!);

const view = runViewFromStoredEvents(events);
const metrics = rollupV2(view, 10_000);

assert.equal(view.egress.length, 4);
assert.equal(metrics.version, 2);
assert.equal(metrics.source, 'event_ledger');
assert.equal(metrics.lastSeq, 14);
assert.deepEqual(metrics.usage.modelCalls, {
  agent: 2,
  jev: 1,
  total: 3,
  local: 1,
  cloud: 1,
  completed: 1,
  failed: 1,
  inFlight: 0,
});
assert.equal(metrics.usage.agentModels.tokensIn.value, 100);
assert.deepEqual(metrics.usage.agentModels.tokensIn.coverage, {
  known: 1,
  total: 2,
  ratio: 0.5,
  complete: false,
});
assert.equal(metrics.usage.total.totalTokens.value, 132);
assert.equal(metrics.usage.total.totalTokens.source, 'provider_reported');
assert.equal(metrics.usage.total.estimatedCostCents.value, 0.2);
assert.equal(metrics.usage.total.estimatedCostCents.coverage.known, 1);
assert.equal(metrics.usage.total.estimatedCostCents.coverage.total, 4);
assert.equal(metrics.timing.wallMs.value, 10_000);
assert.equal(metrics.timing.pausedMs.value, 1_000);
assert.equal(metrics.timing.approvalWaitMs.value, 2_000);
assert.equal(metrics.timing.activeExecutionMs.value, 6_000);
assert.equal(metrics.timing.providerLatencyMs.value, 1_250);
assert.equal(metrics.tools.candidates, 3);
assert.equal(metrics.tools.exposed, 1);
assert.equal(metrics.tools.proposed, 1);
assert.equal(metrics.tools.executed, 1);
assert.equal(metrics.tools.succeeded, 1);

const missingUsage = rollupV2({
  ...view,
  egress: [],
});
assert.equal(missingUsage.usage.agentModels.tokensIn.value, null);
assert.equal(missingUsage.usage.agentModels.estimatedCostCents.value, null);

const reportedZero = rollupV2({
  ...view,
  modelCalls: view.modelCalls.filter((event) => event.modelCallId === 'call_1'),
  egress: [{ ...view.egress[0]!, tokensIn: 0, tokensOut: 0, estimatedCostCents: 0 }],
});
assert.equal(reportedZero.usage.agentModels.tokensIn.value, 0);
assert.equal(reportedZero.usage.agentModels.estimatedCostCents.value, 0);

console.log('analytics V2 checks passed');
