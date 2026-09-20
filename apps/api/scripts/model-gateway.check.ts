import assert from 'node:assert/strict';
import type { ModelRoute, ToolDescriptor } from '@htn/shared';
import { RunBus } from '../src/core/bus.js';
import { DecisionService } from '../src/core/decisions/service.js';
import { ModelGatewayService } from '../src/core/modelGateway/service.js';
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
const gateway = new ModelGatewayService(decisions, sessions, model, catalog, bus, {
  modelRoutes: () => [NO_TOOL_ROUTE, TOOL_ROUTE, CLOUD_TOOL_ROUTE],
  backend: {
    async complete(input) {
      backendTools = input.tools;
      backendRoute = input.route;
      return { text: 'Search completed.', tokensIn: 8, tokensOut: 3 };
    },
  },
});

async function main(): Promise<void> {
  const state = await sessions.create({
    runId: 'gateway_check',
    stepId: 'gateway_check_step',
    harness: 'hermes',
    objective: 'Search public sources.',
    sanitizedObjective: 'Search public sources.',
    dataLabels: ['public'],
    budget: { stepsRemaining: 2 },
    candidateToolIds: ['browser.search', 'untrusted.delete_everything'],
  });
  await sessions.beginTurn(state.id);

  const completion = await gateway.complete({
    model: 'agentos-router',
    messages: [
      { role: 'system', content: 'Use only the schemas exposed to you.' },
      { role: 'user', content: 'Search public sources.' },
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
    ['select_tool_families', 'select_tools', 'select_model'],
  );

  const grantId = persisted.activeToolExposureGrant?.id;
  await gateway.complete({
    messages: [{ role: 'user', content: 'Create a short conversation title.' }],
  });
  assert.equal(
    (await sessions.get(state.id))?.activeToolExposureGrant?.id,
    grantId,
    'an auxiliary no-tool request must not erase the task tool grant',
  );

  await gateway.complete({
    messages: [{ role: 'tool', content: 'Untrusted raw tool output.' }],
  });
  assert.equal(backendRoute?.deployment, 'local');
  assert.ok(
    (await sessions.get(state.id))?.dataLabels.includes('local_only'),
    'an unsanitized tool message must tighten canonical state to local_only',
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
