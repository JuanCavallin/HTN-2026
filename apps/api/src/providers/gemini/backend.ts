/**
 * Gemini — direct Google backend for the AgentOS model gateway.
 *
 * ============================================================================
 * WHY A DIRECT ROUTE WHEN OPENROUTER ALREADY PROXIES GEMINI.
 *
 * Because a route is a privacy and cost claim, not a model name. An OpenRouter
 * route is egress to OpenRouter, whatever model sits behind it; this is egress
 * to Google. They are different destinations in the ledger, they bill
 * differently, and they fail independently. Collapsing them would make
 * "which vendor saw this context" unanswerable, and that question is the
 * product. Two real cloud vendors is also what makes route selection an actual
 * decision for Jev rather than a label on a single path.
 * ---------------------------------------------------------------------------
 * THE WIRE TRANSLATION, AND WHY IT IS NOT A PASS-THROUGH.
 *
 * Hermes speaks OpenAI chat-completions TO US. Gemini does not speak it. So
 * this file converts in both directions, and three of those conversions are
 * easy to get quietly wrong:
 *
 *   1. SYSTEM MESSAGES. Gemini has no 'system' role. They belong in the
 *      top-level `systemInstruction`, not prepended to the first user turn —
 *      prepending changes what the model treats as instruction vs. content.
 *   2. TOOL RESULTS. OpenAI sends role:'tool' keyed by tool_call_id. Gemini
 *      wants a `functionResponse` part keyed by function NAME, and the name has
 *      to be recovered from the assistant turn that requested it.
 *   3. JSON SCHEMA. Gemini's function declarations reject several standard
 *      JSON Schema keywords that our tool schemas legitimately carry
 *      (`additionalProperties`, `$schema`, `default`). They are stripped rather
 *      than passed through, because a 400 here reads like a model failure.
 *
 * SECURITY, same rule as the OpenRouter backend: a returned function call whose
 * name AgentOS did not expose this turn is rejected, not executed. The gateway
 * filters which tools the model may see; this enforces that it cannot invent
 * one anyway.
 *
 * ONE TOOL CALL PER TURN, also to match OpenRouter. That backend sends
 * `parallel_tool_calls: false`, so every downstream consumer — the broker, the
 * approval gate, the trace — has only ever been exercised with a single call
 * per turn. Gemini has no equivalent request flag, so the constraint is applied
 * to the RESPONSE instead: extras are dropped and warned about rather than fed
 * into a path that has never seen them. Silently passing two through would make
 * the Gemini route behave differently from the OpenRouter one, for reasons a
 * demo would surface at the worst possible moment.
 * ---------------------------------------------------------------------------
 * VERIFIED: endpoint shape, auth header and model ids confirmed against
 * Google's published API docs and Sept-2026 release notes. NOT exercised
 * against a live key here — model ids are env-overridable
 * (GEMINI_CHEAP_MODEL / GEMINI_FRONTIER_MODEL) precisely so a renamed model is
 * a config change, and `health()` lists models so a wrong id is visible on the
 * providers page rather than at demo time.
 * ============================================================================
 */

import type { ModelRoute, ProviderCallContext } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import type {
  ChatModelBackend,
  ChatModelBackendInput,
  ChatModelBackendResult,
  GatewayToolCall,
  OpenAiMessage,
  OpenAiTool,
} from '../../core/modelGateway/service.js';
import { newId } from '../../lib/ids.js';
import type { RecordEgress } from '../withEgress.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT_MS = 45_000;

/** JSON Schema keywords Gemini's functionDeclarations parser rejects outright. */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  'additionalProperties',
  'default',
  'examples',
  'const',
  'definitions',
  '$defs',
  '$ref',
]);

interface GeminiPart {
  text?: string;
  functionCall?: { name?: unknown; args?: unknown };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  modelVersion?: string;
  error?: { message?: string };
}

export function createGeminiBackend(
  cfg: ProviderConfig,
  recordEgress: RecordEgress,
  fallback: ChatModelBackend,
): ChatModelBackend {
  return {
    async complete(input, ctx) {
      if (input.route.providerId !== 'gemini') return fallback.complete(input, ctx);
      if (cfg.mode !== 'live' || !cfg.apiKey) {
        throw new Error('Gemini route selected while GEMINI_MODE is not live.');
      }
      return completeLive(cfg, input, ctx, recordEgress);
    },
  };
}

export function geminiModelRoutes(cfg: ProviderConfig): ModelRoute[] {
  if (cfg.mode !== 'live' || !cfg.models) return [];
  const routes = [
    route('gemini-cheap', cfg.models.cheap, 'cheap'),
    route('gemini-frontier', cfg.models.frontier, 'frontier'),
  ];
  // Both tiers pointed at one model is a valid config; do not offer it twice.
  return routes.filter(
    (candidate, index) =>
      routes.findIndex((other) => other.modelId === candidate.modelId) === index,
  );
}

function route(id: string, modelId: string, costTier: 'cheap' | 'frontier'): ModelRoute {
  return {
    id,
    providerId: 'gemini',
    modelId,
    costTier,
    deployment: 'cloud',
    contextScope: 'public',
    supportsTools: true,
    // Cloud egress to a third party. Until a retention agreement is represented
    // in the route, only explicitly public state may take this path — same
    // constraint the OpenRouter routes carry, for the same reason.
    allowedDataLabels: ['public'],
    enabled: true,
  };
}

// --- request translation -----------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) =>
      part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
        ? [part.text]
        : [],
    )
    .join('');
}

/**
 * Recover tool_call_id -> function name from assistant turns, so a later
 * role:'tool' message can be addressed by name the way Gemini requires.
 */
function toolNamesById(messages: OpenAiMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    const calls = (message as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!call || typeof call !== 'object') continue;
      const { id, function: fn } = call as { id?: unknown; function?: { name?: unknown } };
      if (typeof id === 'string' && typeof fn?.name === 'string') names.set(id, fn.name);
    }
  }
  return names;
}

interface TranslatedRequest {
  contents: { role: 'user' | 'model'; parts: unknown[] }[];
  systemInstruction?: { parts: { text: string }[] };
}

export function toGeminiRequest(messages: OpenAiMessage[]): TranslatedRequest {
  const names = toolNamesById(messages);
  const systemChunks: string[] = [];
  const contents: TranslatedRequest['contents'] = [];

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content);
      if (text) systemChunks.push(text);
      continue;
    }

    if (message.role === 'tool') {
      const name = names.get(message.tool_call_id ?? '') ?? message.name ?? 'tool';
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name,
              // Gemini requires an object here; a bare string is rejected.
              response: { result: textOf(message.content) },
            },
          },
        ],
      });
      continue;
    }

    if (message.role === 'assistant') {
      const parts: unknown[] = [];
      const text = textOf(message.content);
      if (text) parts.push({ text });

      const calls = (message as { tool_calls?: unknown }).tool_calls;
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (!call || typeof call !== 'object') continue;
          const fn = (call as { function?: { name?: unknown; arguments?: unknown } }).function;
          if (typeof fn?.name !== 'string') continue;
          parts.push({ functionCall: { name: fn.name, args: safeArgs(fn.arguments) } });
        }
      }
      // A turn with no parts at all is rejected by the API; drop it instead.
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }

    const text = textOf(message.content);
    if (text) contents.push({ role: 'user', parts: [{ text }] });
  }

  return {
    contents,
    ...(systemChunks.length > 0
      ? { systemInstruction: { parts: [{ text: systemChunks.join('\n\n') }] } }
      : {}),
  };
}

function safeArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Recursively drop keywords Gemini rejects. Structure is otherwise preserved. */
export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (typeof schema !== 'object' || schema === null) return schema;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    output[key] = sanitizeSchema(value);
  }
  return output;
}

export function toGeminiTools(tools: OpenAiTool[]): unknown[] {
  const declarations = tools.flatMap((tool) => {
    const fn = tool.function;
    if (!fn || typeof fn.name !== 'string') return [];
    return [
      {
        name: fn.name,
        description: fn.description ?? '',
        parameters: sanitizeSchema(fn.parameters ?? { type: 'object', properties: {} }),
      },
    ];
  });
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : [];
}

// --- response translation ----------------------------------------------------

/**
 * Convert Gemini function calls into the gateway's OpenAI-shaped tool calls.
 *
 * Throws on a name AgentOS did not expose this turn. That is the same rule the
 * OpenRouter backend enforces and it is not optional: tool exposure is the
 * boundary, so a model naming something outside it is a failure, not a request.
 */
export function parseToolCalls(
  parts: GeminiPart[],
  input: ChatModelBackendInput,
): GatewayToolCall[] {
  const allowed = new Set(
    input.tools.flatMap((tool) =>
      typeof tool.function?.name === 'string' ? [tool.function.name] : [],
    ),
  );

  const calls = parts.flatMap((part, index) => {
    const call = part.functionCall;
    if (!call) return [];
    if (typeof call.name !== 'string' || !allowed.has(call.name)) {
      throw new Error('Gemini requested a tool that AgentOS did not expose.');
    }
    return [
      {
        // Gemini returns no call id; the gateway needs a stable one per turn.
        id: 'call_' + index,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      },
    ];
  });

  // Validation above runs over EVERY call first, so an unexposed tool is still
  // refused even when it is one we would go on to drop.
  if (calls.length > 1) {
    console.warn(
      '[gemini] model returned ' +
        calls.length.toString() +
        ' tool calls; keeping the first to match the one-call-per-turn contract.',
    );
    return calls.slice(0, 1);
  }
  return calls;
}

async function completeLive(
  cfg: ProviderConfig,
  input: ChatModelBackendInput,
  ctx: ProviderCallContext,
  recordEgress: RecordEgress,
): Promise<ChatModelBackendResult> {
  const started = Date.now();
  const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const endpoint = baseUrl + '/models/' + input.route.modelId + ':generateContent';
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;

  try {
    const translated = toGeminiRequest(input.messages);
    const tools = toGeminiTools(input.tools);
    const payload = {
      ...translated,
      ...(tools.length > 0 ? { tools } : {}),
      ...(input.maxTokens ? { generationConfig: { maxOutputTokens: input.maxTokens } } : {}),
    };

    const response = await fetchWithOneRetry(endpoint, cfg.apiKey ?? '', payload, ctx.signal);
    if (!response.ok) {
      throw new Error('Gemini returned HTTP ' + response.status + (await safeDetail(response)));
    }

    const body = (await response.json()) as GeminiResponse;
    const parts = body.candidates?.[0]?.content?.parts;
    if (!parts) {
      // A blocked or empty candidate is a real outcome, not a parse bug — say which.
      const reason = body.candidates?.[0]?.finishReason ?? body.error?.message ?? 'no candidate';
      throw new Error('Gemini returned no content (' + reason + ').');
    }

    tokensIn = finite(body.usageMetadata?.promptTokenCount) ?? 0;
    tokensOut = finite(body.usageMetadata?.candidatesTokenCount) ?? 0;

    return {
      text: parts.flatMap((part) => (typeof part.text === 'string' ? [part.text] : [])).join(''),
      toolCalls: parseToolCalls(parts, input),
      tokensIn,
      tokensOut,
      actualModel: body.modelVersion ?? input.route.modelId,
    };
  } finally {
    // Recorded in `finally` so a thrown request still leaves a ledger row: a
    // failed call still opened a connection to Google.
    await recordEgress({
      id: newId('egr'),
      runId: ctx.runId,
      stepId: ctx.stepId,
      providerId: 'gemini',
      op: 'generateContent',
      destination: endpoint,
      dataSpans: ctx.redactions ?? [],
      policyRule: ctx.policyRule,
      latencyMs: Date.now() - started,
      tokensIn,
      tokensOut,
    }).catch((error: unknown) => {
      console.error(
        '[egress] failed to record Gemini call:',
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
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }
    return response;
  }
  throw new Error('Gemini retry loop exhausted.');
}

async function safeDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 400);
    return text ? ': ' + text : '';
  } catch {
    return '';
  }
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
