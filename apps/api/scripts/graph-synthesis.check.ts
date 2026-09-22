/** Offline synthesis regression tests: no provider, runtime singleton, store, or network. */
import assert from 'node:assert/strict';
import { agentGraphSchema, delegationOf, hasRuntimeDelegation, type GraphNode } from '@htn/shared';
import {
  synthesiseGraph,
  SynthesisError,
  type SynthesisDependencies,
  type SynthesisRequest,
} from '../src/core/graph/synthesizer.js';
import {
  buildSynthesisSystemPrompt,
  type ToolCatalogEntry,
} from '../src/core/graph/synthesisPrompt.js';
import { resolveRefs } from '../src/core/graph/refs.js';

const tool = (id = 'read'): Extract<GraphNode, { type: 'tool' }> => ({
  id,
  type: 'tool',
  label: 'Read a page',
  position: { x: 0, y: 0 },
  config: { tool: 'test.read', args: { url: 'https://example.com' } },
});
const draft = (nodes: GraphNode[], edges: unknown[] = []) => ({
  name: 'Test workflow',
  nodes,
  edges,
});
const request: SynthesisRequest = {
  conversationId: 'conv_synthesis_test',
  request: 'Read this exact page.',
  currentGraph: null,
};
const catalog: ToolCatalogEntry[] = [
  { name: 'test.read', description: 'Read the page at a URL.', group: 'web' },
  { name: 'test.search', description: 'Search public pages.', group: 'web' },
];

function fixture(replies: unknown[], tools = catalog) {
  const calls: Parameters<SynthesisDependencies['complete']>[] = [];
  const catalogCalls: string[] = [];
  const deps: SynthesisDependencies = {
    async listTools(conversationId) {
      catalogCalls.push(conversationId);
      return tools;
    },
    async complete(input, context) {
      const reply = replies[calls.length];
      calls.push([input, context]);
      assert.notEqual(reply, undefined, 'synthesis made an unexpected extra model call');
      return {
        ok: true,
        data: {
          text: typeof reply === 'string' ? reply : JSON.stringify(reply),
          tokensIn: 12,
          tokensOut: 24,
        },
        meta: {
          provider: 'anthropic',
          mode: 'mock',
          op: 'complete',
          latencyMs: 0,
          destination: null,
        },
      };
    },
  };
  return { deps, calls, catalogCalls };
}

let checks = 0;
async function check(label: string, run: () => void | Promise<void>) {
  await run();
  checks += 1;
  console.log('  [PASS] ' + label);
}

await check(
  'a direct-only graph is accepted on the first attempt without invented delegation',
  async () => {
    const test = fixture([draft([tool()])]);
    const result = await synthesiseGraph(request, test.deps);
    assert.equal(result.attempts, 1);
    assert.equal(test.calls.length, 1);
    assert.deepEqual(
      result.graph.nodes.map((node) => node.type),
      ['tool'],
    );
    assert.equal(result.delegation.fullyPinned, true);
    assert.equal(result.delegation.deferredToolChoices, 0);
    assert.equal(result.delegation.agentSubtasks, 0);
    assert.equal(hasRuntimeDelegation(result.graph), false);
    assert.deepEqual(test.catalogCalls, [request.conversationId]);
    assert.equal(test.calls[0]?.[1].runId, request.conversationId);
    assert.equal(test.calls[0]?.[1].policyRule, 'graph-synthesis');
    assert.match(result.message, /direct tool call/);
    assert.doesNotMatch(result.message, /delegated|rejected|warning/i);
  },
);

await check('upstream-bound arguments remain direct calls and preserve their types', async () => {
  const next: GraphNode = {
    ...tool('next'),
    config: {
      tool: 'test.read',
      args: { url: '{{read.result.nextUrl}}', options: '{{read.result.options}}' },
    },
  };
  const test = fixture([draft([tool(), next], [{ id: 'e1', source: 'read', target: 'next' }])]);
  const result = await synthesiseGraph(request, test.deps);
  assert.equal(result.attempts, 1);
  assert.equal(result.delegation.pinnedCalls, 2);
  assert.deepEqual(
    resolveRefs(result.graph.nodes[1]?.config, {
      read: { result: { nextUrl: 'https://example.com/next', options: { limit: 3 } } },
    }),
    { tool: 'test.read', args: { url: 'https://example.com/next', options: { limit: 3 } } },
  );
});

await check('a single generative transformation needs neither dispatch nor Hermes', async () => {
  const node: GraphNode = {
    id: 'summarize',
    type: 'decide',
    label: 'Summarize notes',
    position: { x: 0, y: 0 },
    config: { prompt: 'Summarize: {{input.notes}}', tier: 'cheap' },
  };
  const test = fixture([draft([node])], []);
  const result = await synthesiseGraph(request, test.deps);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.graph.nodes, [node]);
  assert.equal(result.delegation.candidateTools, 0);
  assert.doesNotMatch(result.message, /deterministic|no model|zero tokens/i);
});

await check(
  'bounded dispatch and a known-tool Hermes task remain distinct accepted paths',
  async () => {
    const dispatch: GraphNode = {
      id: 'choose',
      type: 'dispatch',
      label: 'Choose source',
      position: { x: 0, y: 0 },
      config: {
        goal: 'Choose the relevant source',
        candidateTools: ['test.read', 'test.search'],
        args: {},
        argsFrom: 'static',
      },
    };
    const agent: GraphNode = {
      id: 'research',
      type: 'agent_task',
      label: 'Resolve conflicting evidence',
      position: { x: 0, y: 0 },
      config: {
        goal: 'Investigate conflicting sources until corroborated or report uncertainty.',
        availableTools: ['test.search'],
        harness: 'hermes',
        maxDurationMs: 60000,
        maxFailedToolCalls: 2,
      },
    };
    for (const node of [dispatch, agent]) {
      const test = fixture([draft([node])]);
      const result = await synthesiseGraph(request, test.deps);
      assert.equal(result.attempts, 1);
      assert.deepEqual(result.graph.nodes, [node]);
      assert.equal(hasRuntimeDelegation(result.graph), true);
    }
    assert.equal(delegationOf({ nodes: [agent] }).agentSubtasks, 1);
    assert.equal(delegationOf({ nodes: [agent] }).candidateTools, 1);
  },
);

await check(
  'chat can remove the last agent task without restoring unwanted delegation',
  async () => {
    const previous = agentGraphSchema.parse({
      ...draft([
        { ...tool(), position: { x: 170, y: 260 } },
        {
          id: 'agent',
          type: 'agent_task',
          label: 'Research',
          position: { x: 0, y: 400 },
          config: { goal: 'Research', availableTools: ['test.search'] },
        },
      ]),
      id: 'existing_graph',
      version: 4,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    });
    const before = structuredClone(previous);
    const test = fixture([draft([tool()])]);
    const result = await synthesiseGraph(
      { ...request, request: 'Remove the research step.', currentGraph: previous },
      test.deps,
    );
    assert.equal(result.attempts, 1);
    assert.equal(result.graph.id, previous.id);
    assert.equal(result.graph.createdAt, previous.createdAt);
    assert.deepEqual(result.graph.nodes[0]?.position, { x: 170, y: 260 });
    assert.equal(result.graph.nodes.length, 1);
    assert.equal(result.delegation.fullyPinned, true);
    assert.match(result.message, /^Updated/);
    assert.deepEqual(previous, before);
  },
);

await check(
  'malformed JSON repairs to a direct-only graph, rather than requiring delegation',
  async () => {
    const test = fixture(['not JSON', draft([tool()])]);
    const result = await synthesiseGraph(request, test.deps);
    assert.equal(result.attempts, 2);
    assert.match(test.calls[1]?.[0].prompt ?? '', /not valid JSON/);
  },
);

for (const [label, invalid, hint] of [
  ['duplicate node IDs', draft([tool(), tool()]), /Duplicate node id/],
  [
    'dangling edges',
    draft([tool()], [{ id: 'e1', source: 'read', target: 'missing' }]),
    /does not exist/,
  ],
  ['cycles', draft([tool()], [{ id: 'e1', source: 'read', target: 'read' }]), /cycle/],
  ['invalid tool config', draft([{ ...tool(), config: {} } as GraphNode]), /node type=tool/],
  ['empty workflow', draft([]), /workflow has no nodes/],
  ['missing workflow steps', { name: 'No steps supplied' }, /workflow has no nodes/],
] as const) {
  await check(label + ' still cause a validation repair', async () => {
    const test = fixture([invalid, draft([tool()])]);
    const result = await synthesiseGraph(request, test.deps);
    assert.equal(result.attempts, 2);
    assert.match(test.calls[1]?.[0].prompt ?? '', hint);
    assert.doesNotMatch(test.calls[1]?.[0].prompt ?? '', /Convert at least one step/);
  });
}

await check('two invalid replies still fail closed', async () => {
  const test = fixture(['not JSON', 'still not JSON']);
  await assert.rejects(synthesiseGraph(request, test.deps), SynthesisError);
  assert.equal(test.calls.length, 2);
});

await check('a direct submission retains its explicit approval boundary', async () => {
  const node: GraphNode = {
    id: 'send',
    type: 'submit',
    label: 'Send reviewed message',
    position: { x: 0, y: 0 },
    config: {
      tool: 'test.send',
      args: { body: 'Reviewed text' },
      description: 'Approve this exact message.',
    },
  };
  const test = fixture([draft([node])], [{ name: 'test.send', description: 'Send a message.' }]);
  const result = await synthesiseGraph(request, test.deps);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.graph.nodes, [node]);
  assert.equal(result.delegation.agentSubtasks, 0);
});

await check('a failed model call does not become an executable graph', async () => {
  const test = fixture([]);
  test.deps.complete = async () => ({
    ok: false,
    error: { code: 'UPSTREAM', message: 'offline', retryable: true },
    meta: { provider: 'anthropic', mode: 'mock', op: 'complete', latencyMs: 0, destination: null },
  });
  await assert.rejects(synthesiseGraph(request, test.deps), /Model call failed: offline/);
});

await check(
  'planning rules distinguish feedback from known tools and preserve safety/session guidance',
  () => {
    const prompt = buildSynthesisSystemPrompt(catalog).replace(/\s+/g, ' ');
    assert.match(prompt, /arguments may be literals or.*upstream/s);
    assert.match(prompt, /decide\s+Use for a single generative/);
    assert.match(prompt, /observe.*reason.*act/);
    assert.match(prompt, /even when all tools are known/);
    assert.match(prompt, /graphs without dispatch or agent_task are valid/i);
    assert.match(prompt, /maxDurationMs/);
    assert.match(prompt, /maxFailedToolCalls/);
    assert.match(prompt, /AgentOS.*gateway/);
    assert.match(prompt, /Never put an irreversible tool/);
    assert.match(prompt, /local_only/);
    assert.match(prompt, /\{\{open_store\.result\.sessionId\}\}/);
    assert.match(prompt, /test\.read/);
    assert.match(prompt, /test\.search/);
    assert.doesNotMatch(prompt, /every tool call is pinned will be REJECTED/);
    assert.doesNotMatch(prompt, /Do NOT hand a web lookup to an/);
    assert.doesNotMatch(prompt, /work no listed tool fits/);
    assert.doesNotMatch(prompt, /Costs no model tokens/);
    const empty = buildSynthesisSystemPrompt([]);
    assert.doesNotMatch(empty, /LIVE WEB LOOKUPS/);
    assert.match(empty, /none connected/);
  },
);

console.log('\nALL ' + checks + ' SYNTHESIS CHECKS PASSED');
