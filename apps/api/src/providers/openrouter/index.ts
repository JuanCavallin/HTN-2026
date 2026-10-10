import type {
  ProviderCallContext,
  ProviderMeta,
  ProviderResult,
  WebSearchAdapter,
  WebSearchCitation,
} from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { disabled, mockBase, mockCall } from '../_mock.js';

interface SearchResponse {
  model?: unknown;
  choices?: Array<{
    message?: {
      content?: unknown;
      annotations?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
    cost?: unknown;
  };
}

function meta(
  cfg: ProviderConfig,
  op: string,
  started: number,
  usage: { tokensIn?: number; tokensOut?: number; estimatedCostCents?: number } = {},
): ProviderMeta {
  return {
    provider: 'openrouter',
    op,
    mode: cfg.mode,
    latencyMs: Date.now() - started,
    destination: cfg.mode === 'live' ? (cfg.baseUrl ?? null) : 'mock://openrouter',
    ...usage,
  };
}

export function create(cfg: ProviderConfig): WebSearchAdapter {
  if (cfg.mode !== 'live') return createMock(cfg);

  return {
    id: 'openrouter',
    mode: 'live',
    capabilities: ['web.search'],
    async health(): Promise<ProviderResult<{ detail?: string }>> {
      const started = Date.now();
      try {
        const response = await fetch(
          (cfg.baseUrl ?? 'https://openrouter.ai/api/v1') + '/auth/key',
          {
            headers: { Authorization: 'Bearer ' + cfg.apiKey },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!response.ok) {
          return {
            ok: false,
            error: {
              code: response.status === 401 || response.status === 403 ? 'AUTH' : 'UPSTREAM',
              message: 'OpenRouter credential check returned HTTP ' + response.status + '.',
              retryable: response.status === 429 || response.status >= 500,
            },
            meta: meta(cfg, 'health', started),
          };
        }
        return {
          ok: true,
          data: { detail: 'live; model gateway and grounded web search ready' },
          meta: meta(cfg, 'health', started),
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code:
              error instanceof DOMException && error.name === 'TimeoutError'
                ? 'TIMEOUT'
                : 'UPSTREAM',
            message: 'OpenRouter credential check failed.',
            retryable: true,
          },
          meta: meta(cfg, 'health', started),
        };
      }
    },
    async invoke<TIn, TOut>(op: string): Promise<ProviderResult<TOut>> {
      return {
        ok: false,
        error: {
          code: 'BAD_INPUT',
          message: 'OpenRouter operation is not exposed through generic invoke: ' + op,
          retryable: false,
        },
        meta: meta(cfg, op, Date.now()),
      };
    },
    async search(input, ctx) {
      return searchLive(cfg, input, ctx);
    },
  };
}

function createMock(cfg: ProviderConfig): WebSearchAdapter {
  const base = mockBase('openrouter', ['web.search'], cfg.mode);
  return {
    ...base,
    async search(input, ctx) {
      if (cfg.mode === 'disabled') return disabled('openrouter', 'search');
      return mockCall('openrouter', 'search', cfg.mode, ctx, () => ({
        answer: 'Mock grounded search result for: ' + input.query,
        citations: [
          {
            url: 'https://example.invalid/search-result',
            title: 'Mock search result',
            excerpt: 'No live internet request was made.',
          },
        ],
        actualModel: 'mock-search',
      }));
    },
  };
}

async function searchLive(
  cfg: ProviderConfig,
  input: { query: string; maxResults?: number },
  ctx: ProviderCallContext,
): Promise<
  ProviderResult<{ answer: string; citations: WebSearchCitation[]; actualModel?: string }>
> {
  const started = Date.now();
  const endpoint = (cfg.baseUrl ?? 'https://openrouter.ai/api/v1') + '/chat/completions';
  const query = input.query.trim();
  if (!query) {
    return {
      ok: false,
      error: {
        code: 'BAD_INPUT',
        message: 'Web search query is required.',
        retryable: false,
      },
      meta: meta(cfg, 'search', started),
    };
  }
  if (!cfg.apiKey || !cfg.models?.cheap) {
    return {
      ok: false,
      error: {
        code: 'AUTH',
        message: 'Live web search requires OPENROUTER_API_KEY and a configured cheap model.',
        retryable: false,
      },
      meta: meta(cfg, 'search', started),
    };
  }

  try {
    const maxResults = Math.max(1, Math.min(5, input.maxResults ?? 3));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.apiKey,
        'Content-Type': 'application/json',
        'X-Title': 'AgentOS grounded web search',
      },
      body: JSON.stringify({
        model: cfg.models.cheap,
        messages: [
          {
            role: 'system',
            content:
              'Use web search for the supplied query. Return a concise factual answer and preserve source URLs. Do not rely on prior model knowledge.',
          },
          { role: 'user', content: query },
        ],
        tools: [
          {
            type: 'openrouter:web_search',
            parameters: { engine: 'auto', max_results: maxResults, max_total_results: maxResults },
          },
        ],
        // Search context can consume part of a reasoning model's completion
        // budget before visible text begins. 600 tokens intermittently yielded
        // an empty answer with finish_reason=length; 1200 remains bounded while
        // reliably leaving room for a short cited response.
        max_completion_tokens: Math.min(1_200, cfg.maxOutputTokens ?? 1_200),
        session_id: ctx.runId,
        provider: { allow_fallbacks: true },
      }),
      signal: ctx.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(45_000)])
        : AbortSignal.timeout(45_000),
    });
    const payload = (await response.json()) as SearchResponse;
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code:
            response.status === 401 || response.status === 403
              ? 'AUTH'
              : response.status === 429
                ? 'RATE_LIMIT'
                : 'UPSTREAM',
          message: 'OpenRouter web search returned HTTP ' + response.status.toString() + '.',
          retryable: response.status === 429 || response.status >= 500,
        },
        meta: meta(cfg, 'search', started),
      };
    }
    const message = payload.choices?.[0]?.message;
    const answer = contentText(message?.content).trim();
    if (!answer) throw new Error('OpenRouter web search returned no answer.');
    const citations = dedupeCitations([
      ...parseCitations(message?.annotations),
      ...parseInlineCitations(answer),
    ]);
    const tokensIn = finiteNumber(payload.usage?.prompt_tokens ?? payload.usage?.input_tokens);
    const tokensOut = finiteNumber(
      payload.usage?.completion_tokens ?? payload.usage?.output_tokens,
    );
    const dollars = finiteNumber(payload.usage?.cost);
    const actualModel = typeof payload.model === 'string' ? payload.model : undefined;
    return {
      ok: true,
      data: {
        answer,
        citations,
        ...(actualModel ? { actualModel } : {}),
      },
      meta: meta(cfg, 'search', started, {
        ...(tokensIn !== undefined ? { tokensIn } : {}),
        ...(tokensOut !== undefined ? { tokensOut } : {}),
        ...(dollars !== undefined ? { estimatedCostCents: dollars * 100 } : {}),
      }),
    };
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    return {
      ok: false,
      error: {
        code: timedOut ? 'TIMEOUT' : 'UPSTREAM',
        message: timedOut
          ? 'OpenRouter web search timed out.'
          : error instanceof Error
            ? error.message
            : 'OpenRouter web search failed.',
        retryable: true,
      },
      meta: meta(cfg, 'search', started),
    };
  }
}

function parseCitations(value: unknown): WebSearchCitation[] {
  if (!Array.isArray(value)) return [];
  const citations = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const citation = (item as { url_citation?: unknown }).url_citation;
    if (!citation || typeof citation !== 'object') return [];
    const candidate = citation as { url?: unknown; title?: unknown; content?: unknown };
    if (typeof candidate.url !== 'string') return [];
    return [
      {
        url: candidate.url,
        ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
        ...(typeof candidate.content === 'string' ? { excerpt: candidate.content } : {}),
      },
    ];
  });
  return dedupeCitations(citations);
}

function parseInlineCitations(answer: string): WebSearchCitation[] {
  const citations: WebSearchCitation[] = [];
  const markdownLinks = answer.matchAll(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g);
  for (const match of markdownLinks) {
    if (!match[2]) continue;
    citations.push({ url: cleanUrl(match[2]), ...(match[1] ? { title: match[1] } : {}) });
  }
  for (const match of answer.matchAll(/https?:\/\/[^\s)>\]}]+/g)) {
    citations.push({ url: cleanUrl(match[0]) });
  }
  return dedupeCitations(citations);
}

function cleanUrl(value: string): string {
  return value.replace(/[.,;:!?]+$/, '');
}

function dedupeCitations(citations: WebSearchCitation[]): WebSearchCitation[] {
  return [...new Map(citations.map((citation) => [citation.url, citation])).values()];
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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
