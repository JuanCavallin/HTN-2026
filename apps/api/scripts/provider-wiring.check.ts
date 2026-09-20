import assert from 'node:assert/strict';
import { createOllamaBackend, ollamaModelRoutes } from '../src/providers/ollama/backend.js';
import { create as createOllama } from '../src/providers/ollama/index.js';
import { create as createComposio } from '../src/providers/composio/index.js';
import { config } from '../src/config.js';
import {
  createOpenRouterBackend,
  openRouterModelRoutes,
} from '../src/providers/openrouter/backend.js';
import { create as createOpenRouter } from '../src/providers/openrouter/index.js';

const ollamaConfig = {
  mode: 'live' as const,
  keyVar: 'OLLAMA_BASE_URL',
  baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
  models: {
    cheap: process.env.OLLAMA_MODEL ?? 'qwen3:8b',
    frontier: process.env.OLLAMA_MODEL ?? 'qwen3:8b',
  },
};

const health = await createOllama(ollamaConfig).health();
assert.equal(health.ok, true, health.ok ? undefined : health.error.message);
const routes = ollamaModelRoutes(ollamaConfig);
assert.equal(routes.length, 1);
assert.equal(routes[0]?.deployment, 'local');
assert.equal(routes[0]?.supportsTools, true);

const egress: unknown[] = [];
const backend = createOllamaBackend(
  ollamaConfig,
  async (event) => {
    egress.push(event);
  },
  {
    async complete() {
      throw new Error('unexpected fallback');
    },
  },
);
const completion = await backend.complete(
  {
    route: routes[0]!,
    messages: [{ role: 'user', content: 'Reply with only the word OK.' }],
    tools: [],
    maxTokens: 16,
  },
  { runId: 'provider_check', policyRule: 'provider-wiring-check' },
);
assert.ok(completion.text.trim().length > 0);
assert.ok(completion.tokensIn >= 0);
assert.equal(egress.length, 1);

const toolCompletion = await backend.complete(
  {
    route: routes[0]!,
    messages: [{ role: 'user', content: 'You must call get_weather for Toronto.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather for a city.',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
  },
  { runId: 'provider_check_tools', policyRule: 'provider-wiring-check' },
);
assert.equal(toolCompletion.toolCalls?.[0]?.function.name, 'get_weather');
assert.deepEqual(JSON.parse(toolCompletion.toolCalls?.[0]?.function.arguments ?? '{}'), {
  city: 'Toronto',
});

const composio = createComposio({ mode: 'mock', keyVar: 'COMPOSIO_API_KEY' });
const tools = await composio.listTools({
  runId: 'provider_check',
  policyRule: 'provider-wiring-check',
});
assert.equal(tools.ok, true);
assert.ok(tools.ok && tools.data.some((tool) => tool.name === 'GMAIL_SEND_EMAIL'));

if (process.env.OPENROUTER_LIVE_CHECK === '1') {
  const cfg = config.providers.openrouter;
  assert.equal(cfg.mode, 'live', 'OPENROUTER_LIVE_CHECK requires OPENROUTER_MODE=live and a key');
  const openRouterHealth = await createOpenRouter(cfg).health();
  assert.equal(
    openRouterHealth.ok,
    true,
    openRouterHealth.ok ? undefined : openRouterHealth.error.message,
  );
  const cloudRoutes = openRouterModelRoutes(cfg);
  assert.equal(cloudRoutes.length, 2);
  const cloudEgress: unknown[] = [];
  const cloud = createOpenRouterBackend(
    cfg,
    async (event) => {
      cloudEgress.push(event);
    },
    {
      async complete() {
        throw new Error('unexpected OpenRouter fallback');
      },
    },
  );
  const cloudCompletion = await cloud.complete(
    {
      route: cloudRoutes[0]!,
      messages: [{ role: 'user', content: 'Reply with only OK.' }],
      tools: [],
      maxTokens: 32,
    },
    { runId: 'openrouter_live_check', policyRule: 'provider-wiring-check' },
  );
  assert.ok(cloudCompletion.actualModel);
  assert.equal(cloudEgress.length, 1);
}

console.log('provider wiring check: ok (ollama=' + ollamaConfig.models.cheap + ')');
