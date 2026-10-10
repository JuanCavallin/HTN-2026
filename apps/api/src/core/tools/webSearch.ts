import type { Json, ToolDescriptor, WebSearchAdapter } from '@htn/shared';
import type { InMemoryToolExecutorRegistry } from './executors.js';
import type { InMemoryToolRegistry } from './registry.js';

export const WEB_SEARCH_TOOL_ID = 'web.search';
export const WEB_SEARCH_EXECUTOR_REF = 'provider://web.search';
const WEB_SEARCH_DESTINATION = 'https://openrouter.ai/api/v1/chat/completions';

/** Build a focused public query without asking a model to rewrite obvious input. */
export function webSearchArgumentsForTask(task: string): Record<string, Json> | null {
  const query = task
    .trim()
    .replace(
      /^(?:please\s+)?(?:search|look\s*up|lookup|find|research)(?:\s+(?:google|the\s+web|the\s+internet|online))?(?:\s+for)?\s+/i,
      '',
    )
    .trim();
  if (query.length < 2) return null;
  return { query, maxResults: 3 };
}

export function registerWebSearchTool(
  registry: InMemoryToolRegistry,
  executors: InMemoryToolExecutorRegistry,
  adapter: WebSearchAdapter,
  available: boolean,
): void {
  const descriptor: ToolDescriptor = {
    id: WEB_SEARCH_TOOL_ID,
    version: '1',
    providerId: 'openrouter',
    family: 'web',
    description:
      'Search the live public internet and return a concise grounded answer with source URLs. Use for current web information; use weather.forecast for weather and browser tools for interacting with a specific page.',
    capabilities: ['web.search'],
    aliases: ['google search', 'internet search', 'look up online', 'search the web', 'web search'],
    inputSchemaRef: 'agentos://schemas/web.search/1',
    transport: 'http',
    baselineEffect: 'read',
    reversibility: 'reversible',
    requiredScopes: [],
    allowedDataLabels: ['public'],
    availability: available ? 'available' : 'unavailable',
    executorRef: WEB_SEARCH_EXECUTOR_REF,
    credentialRef: 'OPENROUTER_API_KEY',
  };
  registry.register({
    descriptor,
    wireName: 'web_search',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 2,
          maxLength: 500,
          description: 'A focused public-web search query.',
        },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description: 'Maximum grounded sources. Defaults to 3.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  });

  executors.register({
    ref: WEB_SEARCH_EXECUTOR_REF,
    destinationFor: () => WEB_SEARCH_DESTINATION,
    async execute(action, ctx) {
      const args = objectArgs(action.arguments);
      const query = requiredString(args, 'query');
      const requestedMax = args.maxResults;
      const maxResults =
        typeof requestedMax === 'number' && Number.isInteger(requestedMax)
          ? requestedMax
          : undefined;
      const result = await adapter.search(
        { query, ...(maxResults !== undefined ? { maxResults } : {}) },
        { ...ctx, policyRule: 'grounded-web-search' },
      );
      if (!result.ok) throw new Error(result.error.message);
      const citations = result.data.citations
        .slice(0, 5)
        .map((citation) => (citation.title ? citation.title + ' — ' : '') + citation.url)
        .join('; ');
      const summary = truncate(
        'Grounded web search answer: ' +
          result.data.answer +
          (citations ? '\nSources: ' + citations : ''),
        3_500,
      );
      return {
        output: {
          query,
          answer: result.data.answer,
          citations: result.data.citations,
          ...(result.data.actualModel ? { actualModel: result.data.actualModel } : {}),
        } as unknown as Json,
        summary,
        sanitizedSummary: summary,
        dataLabels: [...action.dataLabels],
        verified: result.data.citations.length > 0,
      };
    },
  });
}

function objectArgs(value: Json): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Web search arguments must be an object.');
  }
  return value;
}

function requiredString(value: Record<string, Json>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || item.trim().length < 2) {
    throw new Error('Web search query is required.');
  }
  return item.trim();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 3) + '...';
}
