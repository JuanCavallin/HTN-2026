import type { ModelRoute, ProviderCallContext } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import type {
  ChatModelBackend,
  ChatModelBackendInput,
  ChatModelBackendResult,
  GatewayToolCall,
} from '../../core/modelGateway/service.js';
import { newId } from '../../lib/ids.js';
import type { RecordEgress } from '../withEgress.js';

interface OpenRouterResponse {
  model?: string;
  choices?: {
    message?: {
      content?: unknown;
      tool_calls?: unknown;
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
}

/** Direct OpenRouter backend used only by the AgentOS model gateway. */
export function createOpenRouterBackend(
  cfg: ProviderConfig,
  recordEgress: RecordEgress,
  fallback: ChatModelBackend,
): ChatModelBackend {
  return {
    async complete(input, ctx) {
      if (input.route.providerId !== 'openrouter') return fallback.complete(input, ctx);
      if (cfg.mode !== 'live' || !cfg.apiKey) {
        throw new Error('OpenRouter route selected while OPENROUTER_MODE is not live.');
      }
      return completeLive(cfg, input, ctx, recordEgress);
    },
  };
}

export function openRouterModelRoutes(cfg: ProviderConfig): ModelRoute[] {
  if (cfg.mode !== 'live' || !cfg.models) return [];
  const routes: ModelRoute[] = [
    route('openrouter-cheap', cfg.models.cheap, 'cheap'),
    route('openrouter-frontier', cfg.models.frontier, 'frontier'),
  ];
  return routes.filter(
    (candidate, index) =>
      routes.findIndex((other) => other.modelId === candidate.modelId) === index,
  );
}

function route(id: string, modelId: string, costTier: 'cheap' | 'frontier'): ModelRoute {
  return {
    id,
    providerId: 'openrouter',
    modelId,
    costTier,
    deployment: 'cloud',
    contextScope: 'public',
    supportsTools: true,
    allowedDataLabels: ['public'],
    enabled: true,
  };
}

async function completeLive(
  cfg: ProviderConfig,
  input: ChatModelBackendInput,
  ctx: ProviderCallContext,
  recordEgress: RecordEgress,
): Promise<ChatModelBackendResult> {
  const started = Date.now();
  const endpoint = (cfg.baseUrl ?? 'https://openrouter.ai/api/v1') + '/chat/completions';
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  let estimatedCostCents: number | undefined;
  try {
    const payload = {
      model: input.route.modelId,
      messages: input.messages,
      ...(input.tools.length > 0
        ? { tools: input.tools, tool_choice: 'auto', parallel_tool_calls: false }
        : {}),
      ...(input.maxTokens ? { max_completion_tokens: input.maxTokens } : {}),
      session_id: ctx.runId,
      provider: { allow_fallbacks: true },
    };
    const response = await fetchWithOneRetry(endpoint, cfg.apiKey ?? '', payload, ctx.signal);
    if (!response.ok) {
      const detail = await safeErrorDetail(response);
      throw new Error('OpenRouter returned HTTP ' + response.status + detail);
    }
    const body = (await response.json()) as OpenRouterResponse;
    const choice = body.choices?.[0]?.message;
    if (!choice) throw new Error('OpenRouter returned no completion choice.');
    tokensIn = finiteNumber(body.usage?.prompt_tokens) ?? 0;
    tokensOut = finiteNumber(body.usage?.completion_tokens) ?? 0;
    const dollars = finiteNumber(body.usage?.cost);
    estimatedCostCents = dollars === undefined ? undefined : dollars * 100;
    return {
      text: contentText(choice.content),
      toolCalls: parseToolCalls(choice.tool_calls, input),
      tokensIn,
      tokensOut,
      actualModel: body.model,
      estimatedCostCents,
    };
  } finally {
    await recordEgress({
      id: newId('egr'),
      runId: ctx.runId,
      stepId: ctx.stepId,
      providerId: 'openrouter',
      op: 'chat.completions',
      destination: endpoint,
      dataSpans: ctx.redactions ?? [],
      policyRule: ctx.policyRule,
      latencyMs: Date.now() - started,
      tokensIn,
      tokensOut,
      estimatedCostCents,
    }).catch((error: unknown) => {
      console.error(
        '[egress] failed to record OpenRouter call:',
        error instanceof Error ? error.message : 'unknown error',
      );
    });
  }
}

async function fetchWithOneRetry(
  endpoint: string,
  apiKey: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'X-Title': 'AgentOS',
      },
      body: JSON.stringify(payload),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(45_000)])
        : AbortSignal.timeout(45_000),
    });
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }
    return response;
  }
  throw new Error('OpenRouter retry loop exhausted.');
}

function parseToolCalls(value: unknown, input: ChatModelBackendInput): GatewayToolCall[] {
  if (!Array.isArray(value)) return [];
  const allowedNames = new Set(
    input.tools.flatMap((tool) =>
      typeof tool.function?.name === 'string' ? [tool.function.name] : [],
    ),
  );
  return value.map((item, index) => {
    if (!item || typeof item !== 'object')
      throw new Error('OpenRouter returned an invalid tool call.');
    const candidate = item as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const name = candidate.function?.name;
    const args = candidate.function?.arguments;
    if (typeof name !== 'string' || !allowedNames.has(name)) {
      throw new Error('OpenRouter requested a tool that AgentOS did not expose.');
    }
    if (typeof args !== 'string') throw new Error('OpenRouter returned invalid tool arguments.');
    return {
      id: typeof candidate.id === 'string' ? candidate.id : 'call_' + index,
      type: 'function',
      function: { name, arguments: args },
    };
  });
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .flatMap((part) =>
      part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
        ? [part.text]
        : [],
    )
    .join('\n');
}

async function safeErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    const message = body.error?.message;
    return typeof message === 'string' ? ': ' + message.slice(0, 240) : '.';
  } catch {
    return '.';
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
