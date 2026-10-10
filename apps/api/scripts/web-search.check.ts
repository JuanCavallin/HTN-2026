import assert from 'node:assert/strict';
import type { ProviderCallContext, WebSearchAdapter } from '@htn/shared';
import { InMemoryToolExecutorRegistry } from '../src/core/tools/executors.js';
import { InMemoryToolRegistry } from '../src/core/tools/registry.js';
import {
  registerWebSearchTool,
  webSearchArgumentsForTask,
  WEB_SEARCH_EXECUTOR_REF,
} from '../src/core/tools/webSearch.js';

assert.deepEqual(webSearchArgumentsForTask('Search Google for the latest OpenAI API news.'), {
  query: 'the latest OpenAI API news.',
  maxResults: 3,
});
assert.deepEqual(webSearchArgumentsForTask("What are today's top AI news stories?"), {
  query: "What are today's top AI news stories?",
  maxResults: 3,
});

const adapter: WebSearchAdapter = {
  id: 'openrouter',
  mode: 'live',
  capabilities: ['web.search'],
  async health() {
    return { ok: true, data: {}, meta: meta('health') };
  },
  async invoke() {
    throw new Error('Generic invoke is not used.');
  },
  async search(input) {
    assert.equal(input.query, 'latest OpenAI API news');
    assert.equal(input.maxResults, 3);
    return {
      ok: true,
      data: {
        answer: 'A grounded answer.',
        citations: [
          { title: 'Official source', url: 'https://example.com/source' },
          { url: 'https://example.com/untitled' },
        ],
        actualModel: 'search-model',
      },
      meta: meta('search'),
    };
  },
};

const registry = new InMemoryToolRegistry();
const executors = new InMemoryToolExecutorRegistry();
registerWebSearchTool(registry, executors, adapter, true);

const registered = await registry.get('web.search');
assert.equal(registered?.descriptor.availability, 'available');
assert.deepEqual(registered?.descriptor.capabilities, ['web.search']);

const executor = executors.resolve(WEB_SEARCH_EXECUTOR_REF);
assert.ok(executor);
const context: ProviderCallContext = {
  runId: 'run_web_search_check',
  stepId: 'step_web_search_check',
  policyRule: 'authorized-tool-action',
};
const result = await executor.execute(
  {
    id: 'act_web_search_check',
    runId: context.runId,
    stepId: context.stepId!,
    toolId: 'web.search',
    descriptorVersion: '1',
    operation: 'web.search',
    arguments: { query: 'latest OpenAI API news', maxResults: 3 },
    destination: 'https://openrouter.ai/api/v1/chat/completions',
    dataLabels: ['public'],
    createdAt: new Date().toISOString(),
  },
  context,
);

assert.equal(result.verified, true);
assert.match(result.summary, /grounded answer/i);
assert.match(result.summary, /https:\/\/example\.com\/source/);
assert.match(result.summary, /https:\/\/example\.com\/untitled/);
assert.doesNotMatch(result.summary, /undefined/);

console.log('PASS: grounded web search is registered, cited, and completion-verifiable.');

function meta(op: string) {
  return {
    provider: 'openrouter' as const,
    op,
    mode: 'live' as const,
    latencyMs: 0,
    destination: 'https://openrouter.ai/api/v1/chat/completions',
  };
}
