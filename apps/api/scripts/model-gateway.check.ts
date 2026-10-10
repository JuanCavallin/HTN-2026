import assert from 'node:assert/strict';
import { agentInputSchema, type ModelRoute, type ToolDescriptor } from '@htn/shared';
import { RunBus } from '../src/core/bus.js';
import { DecisionService } from '../src/core/decisions/service.js';
import { configuredModelRoutes } from '../src/core/modelGateway/catalog.js';
import { modelCompletionEvidence } from '../src/core/modelGateway/evidence.js';
import {
  ModelGatewayService,
  normalizeRequestedMaxTokens,
  selectFlagshipRoute,
} from '../src/core/modelGateway/service.js';
import { requiresExternalAction } from '../src/core/orchestrator.js';
import { InMemoryToolDescriptorCatalog } from '../src/core/modelGateway/toolCatalog.js';
import { SessionStateService } from '../src/core/sessions/service.js';
import { create as createTextModel } from '../src/providers/anthropic/index.js';
import { create as createJev } from '../src/providers/jev/index.js';
import { createMemoryStore } from '../src/store/memory.js';

const store = createMemoryStore();
const bus = new RunBus((runId, event) => store.appendEvent(runId, event));
const sessions = new SessionStateService(store);
const decisions = new DecisionService(createJev({ mode: 'mock', keyVar: 'JEV_API_KEY' }));
const model = createTextModel({ mode: 'mock', keyVar: 'ANTHROPIC_API_KEY' });
const catalog = new InMemoryToolDescriptorCatalog();

const SEARCH_TOOL: ToolDescriptor = {
  id: 'browser.search',
  version: '1',
  providerId: 'check',
  family: 'browser',
  description: 'Search public pages.',
  inputSchemaRef: 'check://browser.search',
  transport: 'fixture',
  baselineEffect: 'read',
  reversibility: 'reversible',
  requiredScopes: [],
  allowedDataLabels: ['public'],
  availability: 'available',
  executorRef: 'check://browser.search',
  simulated: true,
};
catalog.register({
  descriptor: SEARCH_TOOL,
  wireName: 'browser_search',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
});

let backendTools: unknown[] = [];
let backendRoute: ModelRoute | undefined;
let backendMaxTokens: number | undefined;
let backendMessages: unknown[] = [];
let backendError: Error | undefined;
const TOOL_ROUTE: ModelRoute = {
  id: 'check-local-tools',
  providerId: 'anthropic',
  modelId: 'check-tools',
  costTier: 'cheap',
  deployment: 'local',
  contextScope: 'local_only',
  supportsTools: true,
  allowedDataLabels: ['public', 'private', 'secret', 'local_only'],
  enabled: true,
};
const NO_TOOL_ROUTE: ModelRoute = {
  ...TOOL_ROUTE,
  id: 'check-local-no-tools',
  modelId: 'check-no-tools',
  supportsTools: false,
};
const CLOUD_TOOL_ROUTE: ModelRoute = {
  ...TOOL_ROUTE,
  id: 'check-cloud-tools',
  modelId: 'check-cloud-tools',
  costTier: 'standard',
  deployment: 'cloud',
  contextScope: 'public',
  allowedDataLabels: ['public'],
};
const FRONTIER_TOOL_ROUTE: ModelRoute = {
  ...CLOUD_TOOL_ROUTE,
  id: 'openrouter-frontier',
  modelId: 'check-frontier',
  costTier: 'frontier',
};
const CHEAP_CLOUD_ROUTE: ModelRoute = {
  ...CLOUD_TOOL_ROUTE,
  id: 'check-cloud-cheap',
  modelId: 'check-cloud-cheap',
  costTier: 'cheap',
  supportsTools: false,
};
const FRONTIER_CLOUD_ROUTE: ModelRoute = {
  ...FRONTIER_TOOL_ROUTE,
  id: 'check-cloud-frontier',
  modelId: 'check-cloud-frontier',
  supportsTools: false,
};
const gateway = new ModelGatewayService(decisions, sessions, model, catalog, bus, {
  modelRoutes: () => [NO_TOOL_ROUTE, TOOL_ROUTE, CLOUD_TOOL_ROUTE],
  maxOutputTokens: 8_192,
  backend: {
    async complete(input) {
      backendTools = input.tools;
      backendRoute = input.route;
      backendMaxTokens = input.maxTokens;
      backendMessages = input.messages;
      if (backendError) throw backendError;
      return { text: 'Search completed.', tokensIn: 8, tokensOut: 3 };
    },
  },
});

async function main(): Promise<void> {
  assert.equal(agentInputSchema.parse({ goal: 'hello' }).executionProfile, 'adaptive');
  assert.equal(
    agentInputSchema.parse({ goal: 'hello', executionProfile: 'hermes_flagship' }).executionProfile,
    'hermes_flagship',
  );
  assert.equal(requiresExternalAction('Reply exactly UI_DEMO_READY.'), false);
  assert.equal(requiresExternalAction('Reply with a one-line answer.'), false);
  assert.equal(requiresExternalAction("Reply to Juan's email."), true);
  assert.equal(requiresExternalAction('Send an email to Juan.'), true);
  assert.equal(
    requiresExternalAction('Use the browser to open https://example.com and return its heading.'),
    true,
  );

  const configuredRoutes = configuredModelRoutes(model, [CLOUD_TOOL_ROUTE]);
  assert.deepEqual(
    configuredRoutes.map((route) => route.id),
    [CLOUD_TOOL_ROUTE.id],
    'simulated model routes must not compete with configured live routes',
  );

  const state = await sessions.create({
    runId: 'gateway_check',
    stepId: 'gateway_check_step',
    harness: 'hermes',
    objective: 'Use the browser to search public sources.',
    sanitizedObjective: 'Use the browser to search public sources.',
    dataLabels: ['public'],
    budget: { stepsRemaining: 2 },
    candidateToolIds: ['browser.search', 'untrusted.delete_everything'],
  });
  await sessions.beginTurn(state.id);

  const completion = await gateway.complete({
    model: 'agentos-router',
    messages: [
      { role: 'system', content: 'Use only the schemas exposed to you.' },
      { role: 'user', content: 'Use the browser to search public sources.' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'mcp__agentos__browser_search',
          parameters: { type: 'object', additionalProperties: true },
        },
      },
      {
        type: 'function',
        function: { name: 'untrusted.delete_everything', parameters: { type: 'object' } },
      },
    ],
    max_completion_tokens: 65_536,
  });

  assert.equal(completion.runId, 'gateway_check');
  assert.ok(completion.text.length > 0);
  assert.deepEqual(completion.selectedToolIds, ['browser.search']);
  assert.deepEqual(backendTools, [
    {
      type: 'function',
      function: {
        name: 'mcp__agentos__browser_search',
        description: 'Search public pages.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
  ]);
  assert.equal(backendRoute?.id, TOOL_ROUTE.id, 'tool schemas require a tool-capable route');
  assert.equal(backendMaxTokens, 8_192, 'Hermes output budgets are clamped for every backend');
  assert.equal(normalizeRequestedMaxTokens(512, 8_192), 512);
  assert.equal(normalizeRequestedMaxTokens(65_536, 8_192), 8_192);
  assert.equal(normalizeRequestedMaxTokens(undefined, 8_192), 8_192);
  assert.equal(normalizeRequestedMaxTokens('65536', 8_192), 8_192);

  const persisted = await sessions.get(state.id);
  assert.ok(persisted);
  assert.equal(persisted.contextVersion, 2);
  assert.equal(persisted.context.length, 3);
  assert.deepEqual(persisted.candidateToolIds, ['browser.search']);
  assert.deepEqual(persisted.selectedToolIds, ['browser.search']);
  assert.deepEqual(persisted.selectedToolVersions, { 'browser.search': '1' });
  assert.deepEqual(persisted.activeToolExposureGrant?.selectedToolVersions, {
    'browser.search': '1',
  });
  assert.ok(persisted.selectedModelRouteId);
  assert.equal(persisted.modelRouteHistory?.length, 1);
  assert.match(
    JSON.stringify(backendMessages),
    /AgentOS durable session context/,
    'every provider receives the model-agnostic durable context packet',
  );

  const modelLifecycle = (await store.eventsSince('gateway_check', 0)).flatMap((stored) =>
    stored.event.type === 'model.lifecycle' ? [stored.event.lifecycle] : [],
  );
  assert.deepEqual(
    modelLifecycle.map((event) => event.phase),
    ['requested', 'completed'],
  );
  assert.equal(modelLifecycle[0]?.routeId, TOOL_ROUTE.id);
  assert.equal(modelLifecycle[1]?.actualModelId, TOOL_ROUTE.modelId);
  assert.deepEqual(modelLifecycle[1]?.selectedToolIds, ['browser.search']);

  const decisionsLogged = (await store.eventsSince('gateway_check', 0)).filter(
    (event) => event.event.type === 'control.decided',
  );
  assert.deepEqual(
    decisionsLogged.map((event) =>
      event.event.type === 'control.decided' ? event.event.decision.operation : '',
    ),
    ['select_tools', 'select_model'],
  );
  const toolSelection = decisionsLogged.find(
    (event) =>
      event.event.type === 'control.decided' && event.event.decision.operation === 'select_tools',
  );
  assert.ok(toolSelection?.event.type === 'control.decided');
  assert.equal(toolSelection.event.decision.candidateScores?.['browser.search'], 0.79);

  const grantId = persisted.activeToolExposureGrant?.id;
  backendError = new Error('simulated provider outage');
  await assert.rejects(
    () =>
      gateway.complete({
        messages: [{ role: 'user', content: 'This model request should fail.' }],
        max_tokens: 65_536,
      }),
    /simulated provider outage/,
  );
  let completionEvidence = modelCompletionEvidence(
    await store.eventsSince('gateway_check', 0),
    'gateway_check_step',
  );
  assert.equal(completionEvidence.verified, false);
  assert.equal(completionEvidence.latest?.phase, 'failed');
  assert.equal(completionEvidence.failureMessage, 'simulated provider outage');

  backendError = undefined;
  await gateway.complete({
    messages: [{ role: 'user', content: 'Create a short conversation title.' }],
  });
  completionEvidence = modelCompletionEvidence(
    await store.eventsSince('gateway_check', 0),
    'gateway_check_step',
  );
  assert.equal(completionEvidence.verified, true, 'a later successful retry supersedes a failure');
  assert.equal(completionEvidence.latest?.phase, 'completed');
  assert.equal(
    (await sessions.get(state.id))?.activeToolExposureGrant?.id,
    grantId,
    'an auxiliary no-tool request must not erase the task tool grant',
  );

  await gateway.complete({
    messages: [{ role: 'tool', content: 'Untrusted raw tool output.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'mcp__agentos__browser_search',
          parameters: { type: 'object', additionalProperties: true },
        },
      },
    ],
  });
  assert.equal(backendRoute?.deployment, 'local');
  assert.deepEqual(
    backendTools,
    [],
    'a tool made privacy-ineligible by raw local context must not be restored by fallback',
  );
  assert.match(
    JSON.stringify(backendMessages[0]),
    /present the retrieved records directly/,
    'the local synthesis call must receive trusted instructions to answer from tool data',
  );
  assert.ok(
    (await sessions.get(state.id))?.dataLabels.includes('local_only'),
    'an unsanitized tool message must tighten canonical state to local_only',
  );

  const flagshipDecision = selectFlagshipRoute(
    {
      taskSummary: 'Public task.',
      dataLabels: ['public'],
      sanitizedForRemote: true,
    },
    [TOOL_ROUTE, FRONTIER_TOOL_ROUTE],
  );
  assert.equal(flagshipDecision.selectedRouteId, FRONTIER_TOOL_ROUTE.id);

  const baselineStore = createMemoryStore();
  const baselineBus = new RunBus((runId, event) => baselineStore.appendEvent(runId, event));
  const baselineSessions = new SessionStateService(baselineStore);
  let baselineRoute: ModelRoute | undefined;
  let baselineMessages: unknown[] = [];
  const baselineGateway = new ModelGatewayService(
    decisions,
    baselineSessions,
    model,
    catalog,
    baselineBus,
    {
      modelRoutes: () => [FRONTIER_TOOL_ROUTE],
      flagshipRouteId: FRONTIER_TOOL_ROUTE.id,
      backend: {
        async complete(input) {
          baselineRoute = input.route;
          baselineMessages = input.messages;
          return { text: 'Baseline answer.', tokensIn: 10, tokensOut: 2 };
        },
      },
    },
  );
  const baselineState = await baselineSessions.create({
    runId: 'baseline_gateway_check',
    stepId: 'baseline_gateway_step',
    harness: 'hermes',
    executionProfile: 'hermes_flagship',
    objective: 'Answer this public question.',
    sanitizedObjective: 'Answer this public question.',
    dataLabels: ['public'],
    budget: { stepsRemaining: 2 },
  });
  await baselineSessions.beginTurn(baselineState.id);
  await baselineGateway.complete({ messages: [{ role: 'user', content: 'Same prompt.' }] });
  await baselineGateway.complete({ messages: [{ role: 'user', content: 'Same prompt.' }] });
  const persistedBaseline = await baselineSessions.get(baselineState.id);
  assert.equal(baselineRoute?.id, FRONTIER_TOOL_ROUTE.id);
  assert.equal(persistedBaseline?.fixedModelRouteId, FRONTIER_TOOL_ROUTE.id);
  assert.deepEqual(
    persistedBaseline?.modelRouteHistory?.map((entry) => entry.routeId),
    [FRONTIER_TOOL_ROUTE.id, FRONTIER_TOOL_ROUTE.id],
    'the Hermes baseline pins one flagship route for the full session',
  );
  assert.equal(
    persistedBaseline?.contextVersion,
    2,
    'replayed harness transcripts are de-duplicated instead of inflating durable context',
  );
  assert.match(JSON.stringify(baselineMessages), /Original objective: Answer this public question/);
  const baselineDecisions = (await baselineStore.eventsSince('baseline_gateway_check', 0)).flatMap(
    (stored) => (stored.event.type === 'control.decided' ? [stored.event.decision] : []),
  );
  assert.ok(
    baselineDecisions
      .filter((decision) => decision.operation === 'select_model')
      .every(
        (decision) =>
          decision.source === 'deterministic' &&
          decision.reasonCodes.includes('hermes-flagship-fixed-route'),
      ),
    'the baseline must never masquerade as a Jev-routed model decision',
  );

  const switchingStore = createMemoryStore();
  const switchingBus = new RunBus((runId, event) => switchingStore.appendEvent(runId, event));
  const switchingSessions = new SessionStateService(switchingStore);
  const selectedAdaptiveRoutes: string[] = [];
  const switchingGateway = new ModelGatewayService(
    decisions,
    switchingSessions,
    model,
    catalog,
    switchingBus,
    {
      modelRoutes: () => [CHEAP_CLOUD_ROUTE, FRONTIER_CLOUD_ROUTE],
      backend: {
        async complete(input) {
          selectedAdaptiveRoutes.push(input.route.id);
          return { text: 'Adaptive answer.', tokensIn: 4, tokensOut: 2 };
        },
      },
    },
  );
  const switchingState = await switchingSessions.create({
    runId: 'adaptive_switch_check',
    stepId: 'adaptive_switch_step',
    harness: 'hermes',
    executionProfile: 'adaptive',
    objective: 'Answer each request using the cheapest capable model.',
    sanitizedObjective: 'Answer each request using the cheapest capable model.',
    dataLabels: ['public'],
    budget: { stepsRemaining: 3 },
  });
  await switchingSessions.beginTurn(switchingState.id);
  await switchingGateway.complete({
    messages: [{ role: 'user', content: 'Give a short greeting.' }],
  });
  await switchingGateway.complete({
    messages: [
      {
        role: 'user',
        content:
          'Perform a rigorous multi-stage architecture analysis with competing constraints, ' +
          'failure modes, privacy boundaries, migration sequencing, quantitative tradeoffs, ' +
          'and a detailed verification strategy for a distributed agent platform that must ' +
          'remain available during a zero-downtime provider migration.',
      },
    ],
  });
  assert.deepEqual(
    selectedAdaptiveRoutes,
    [CHEAP_CLOUD_ROUTE.id, FRONTIER_CLOUD_ROUTE.id],
    'one durable adaptive session must be able to escalate models as turn complexity changes',
  );
  assert.deepEqual(
    (await switchingSessions.get(switchingState.id))?.modelRouteHistory?.map(
      (entry) => entry.routeId,
    ),
    [CHEAP_CLOUD_ROUTE.id, FRONTIER_CLOUD_ROUTE.id],
  );

  await sessions.create({
    runId: 'gateway_check_2',
    stepId: 'gateway_check_step_2',
    harness: 'hermes',
    objective: 'Second concurrent task.',
    sanitizedObjective: 'Second concurrent task.',
    dataLabels: ['public'],
    budget: { stepsRemaining: 1 },
  });
  await assert.rejects(
    () => gateway.complete({ messages: [{ role: 'user', content: 'ambiguous' }] }),
    /Multiple active hermes sessions are ambiguous/,
  );

  console.log('model gateway check: ok');
}

await main();
