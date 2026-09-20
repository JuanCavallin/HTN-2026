import { createHash } from 'node:crypto';
import type {
  DataLabel,
  Json,
  ProviderCallContext,
  ToolboxAdapter,
  ToolboxToolDefinition,
  ToolDescriptor,
} from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import type { InMemoryToolExecutorRegistry } from '../../core/tools/executors.js';
import type { InMemoryToolRegistry } from '../../core/tools/registry.js';

export interface ClassifiedTool {
  toolId: string;
  wireName: string;
  family: string;
  baselineEffect: ToolDescriptor['baselineEffect'];
  reversibility: ToolDescriptor['reversibility'];
  allowedDataLabels: DataLabel[];
}

/** Explicit overrides are the reviewed security boundary for demo-critical operations. */
const REVIEWED: Record<string, ClassifiedTool> = {
  GMAIL_SEND_EMAIL: {
    toolId: 'mail.send',
    wireName: 'mail_send',
    family: 'mail',
    baselineEffect: 'write',
    reversibility: 'irreversible',
    allowedDataLabels: ['public', 'private'],
  },
};

/** Stable AgentOS contract; the adapter translates it to Composio's provider schema. */
const MAIL_SEND_INPUT_SCHEMA: Json = {
  type: 'object',
  properties: {
    to: {
      type: 'string',
      description: 'Primary recipient email address.',
    },
    subject: {
      type: 'string',
      description: 'Optional email subject. Omit it when the user did not provide one.',
    },
    body: {
      type: 'string',
      description: 'Email body exactly as requested by the user.',
    },
    is_html: {
      type: 'boolean',
      description: 'True only when the body contains HTML.',
      default: false,
    },
    cc: {
      type: 'array',
      description: 'Optional carbon-copy recipient email addresses.',
      items: { type: 'string' },
      default: [],
    },
    bcc: {
      type: 'array',
      description: 'Optional blind-carbon-copy recipient email addresses.',
      items: { type: 'string' },
      default: [],
    },
  },
  required: ['to', 'body'],
  additionalProperties: false,
};

const DESTRUCTIVE = new Set([
  'DELETE',
  'REMOVE',
  'REVOKE',
  'CANCEL',
  'TERMINATE',
  'DROP',
  'PURGE',
  'DEACTIVATE',
]);
const IRREVERSIBLE_WRITE = new Set([
  'SEND',
  'SUBMIT',
  'PUBLISH',
  'POST',
  'MERGE',
  'INVITE',
  'TRANSFER',
  'PAY',
  'PURCHASE',
  'TRIGGER',
  'EXECUTE',
  'RUN',
  'REPLY',
  'FORWARD',
]);
const RECOVERABLE_WRITE = new Set([
  'CREATE',
  'UPDATE',
  'PATCH',
  'ADD',
  'APPEND',
  'IMPORT',
  'INSERT',
  'DRAFT',
  'UPLOAD',
  'MOVE',
  'RENAME',
  'SET',
  'MODIFY',
  'ARCHIVE',
  'MARK',
  'ASSIGN',
  'SCHEDULE',
]);
const READ = new Set([
  'GET',
  'LIST',
  'FETCH',
  'SEARCH',
  'FIND',
  'RETRIEVE',
  'QUERY',
  'CHECK',
  'LOOKUP',
  'DOWNLOAD',
  'PROFILE',
  'DETAILS',
  'STATUS',
  'HISTORY',
  'READ',
  'VIEW',
]);
const APPROVAL_SENSITIVE_NOUNS = new Set([
  'AUTH',
  'CREDENTIAL',
  'PASSWORD',
  'PERMISSION',
  'ROLE',
  'TOKEN',
  'WEBHOOK',
  'FORWARDING',
]);

export interface ComposioRegistrationReport {
  registered: string[];
  skipped: string[];
  requiresConnection: string[];
  warning?: string;
}

export interface ComposioDiscoveryInput {
  query: string;
  runId: string;
  stepId?: string;
  toolkits?: string[];
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Imports only task-relevant Composio metadata. Jev sees normalized descriptors;
 * schemas and provider-native identifiers remain inside AgentOS.
 */
export class ComposioToolCatalog {
  constructor(
    private readonly adapter: ToolboxAdapter,
    private readonly cfg: ProviderConfig,
    private readonly registry: InMemoryToolRegistry,
    private readonly executors: InMemoryToolExecutorRegistry,
  ) {}

  async bootstrapReviewed(): Promise<ComposioRegistrationReport> {
    if (this.adapter.mode !== 'live') return emptyReport(this.cfg.toolSlugs ?? []);
    const result = await this.adapter.listTools({
      runId: 'sys_composio_bootstrap',
      policyRule: 'reviewed-tool-registry-bootstrap',
    });
    if (!result.ok) return failureReport(this.cfg.toolSlugs ?? [], result.error.message);
    return this.register(result.data);
  }

  async discoverForTask(input: ComposioDiscoveryInput): Promise<ComposioRegistrationReport> {
    if (this.adapter.mode !== 'live') return emptyReport();
    const ctx: ProviderCallContext = {
      runId: input.runId,
      stepId: input.stepId,
      policyRule: 'task-scoped-tool-catalog-discovery',
      signal: input.signal,
    };
    const result = await this.adapter.searchTools(
      {
        // Search by intent, not recipients or message bodies. This improves
        // relevance and prevents task payloads entering provider query URLs.
        query: catalogIntentQuery(input.query),
        toolkits: input.toolkits ?? this.cfg.toolkits,
        limit: input.limit ?? this.cfg.discoveryLimit,
      },
      ctx,
    );
    if (!result.ok) return failureReport([], result.error.message);
    return this.register(result.data);
  }

  private register(tools: ToolboxToolDefinition[]): ComposioRegistrationReport {
    const report = emptyReport();
    for (const tool of tools) {
      const classified = classifyComposioTool(tool);
      if (!classified || !tool.version || !tool.inputSchema || !tool.toolkit) {
        report.skipped.push(tool.name);
        continue;
      }

      const connectedScope = 'composio:connected:' + tool.toolkit;
      const requiredScopes = [connectedScope, ...(tool.requiredScopes ?? [])];
      const grantedScopes = tool.connectedAccountId ? requiredScopes : [];
      const executorRef = 'composio://' + tool.name + '@' + tool.version;
      const descriptor: ToolDescriptor = {
        id: classified.toolId,
        version: tool.version,
        providerId: 'composio',
        family: classified.family,
        description: trustedDescription(tool),
        inputSchemaRef: 'composio://schemas/' + tool.name + '/' + tool.version,
        transport: 'http',
        baselineEffect: classified.baselineEffect,
        reversibility: classified.reversibility,
        requiredScopes,
        allowedDataLabels: classified.allowedDataLabels,
        availability: tool.connectedAccountId ? 'available' : 'requires_connection',
        executorRef,
        credentialRef: 'composio-connected-account:' + tool.toolkit,
      };
      this.registry.register({
        descriptor,
        wireName: classified.wireName,
        inputSchema: exposedInputSchema(tool),
        grantedScopes,
      });

      this.executors.unregister(executorRef);
      this.executors.register({
        ref: executorRef,
        destinationFor: ({ arguments: args }) =>
          destinationFrom(args) ?? 'composio://' + tool.toolkit + '/' + tool.name,
        execute: async (action, ctx) => {
          const called = await this.adapter.callTool(
            {
              name: tool.name,
              version: tool.version,
              userId: this.cfg.userId,
              connectedAccountId: tool.connectedAccountId,
              args: providerArguments(tool.name, action.arguments),
            },
            ctx,
          );
          if (!called.ok) throw new Error(called.error.message);
          if (isRecord(called.data) && called.data.successful === false) {
            throw new Error('Composio reported that the tool execution failed.');
          }
          const summary = 'Completed ' + classified.toolId + ' through the connected account.';
          const outputLabels =
            classified.baselineEffect === 'read'
              ? mergeLabels(action.dataLabels, ['private'])
              : [...action.dataLabels];
          return {
            output: toJson(called.data),
            summary,
            sanitizedSummary: outputLabels.every((label) => label === 'public')
              ? summary
              : undefined,
            dataLabels: outputLabels,
            verified: true,
          };
        },
      });

      report.registered.push(classified.toolId);
      if (!tool.connectedAccountId) report.requiresConnection.push(classified.toolId);
    }
    report.registered = [...new Set(report.registered)];
    report.skipped = [...new Set(report.skipped)];
    report.requiresConnection = [...new Set(report.requiresConnection)];
    return report;
  }
}

export function catalogIntentQuery(value: string): string {
  let query = value
    .replace(/\[\[[A-Z0-9_]+\]\]/gi, ' ')
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, ' ')
    .replace(/\b(?:with\s+(?:content|body|message)|saying|containing)\b[\s\S]*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(?:send|email|message|invite|notify|forward|reply)\b/i.test(query)) {
    query = query.replace(/\s+to\b[\s\S]*$/i, '').trim();
  }
  return query || 'find relevant tools';
}

/** Compatibility entry point used by provider bootstrap and refresh routes. */
export async function registerReviewedComposioTools(
  adapter: ToolboxAdapter,
  cfg: ProviderConfig,
  registry: InMemoryToolRegistry,
  executors: InMemoryToolExecutorRegistry,
): Promise<ComposioRegistrationReport> {
  return new ComposioToolCatalog(adapter, cfg, registry, executors).bootstrapReviewed();
}

/** Unknown verbs deliberately return null and never become executable tools. */
export function classifyComposioTool(tool: ToolboxToolDefinition): ClassifiedTool | null {
  const reviewed = REVIEWED[tool.name];
  if (reviewed) return reviewed;
  if (!tool.toolkit) return null;

  const tokens = tool.name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const toolkitTokens = tool.toolkit
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const operationTokens = startsWith(tokens, toolkitTokens)
    ? tokens.slice(toolkitTokens.length)
    : tokens;
  const category = classifyTokens(operationTokens);
  if (!category) return null;

  const toolkit = normalizeSegment(tool.toolkit);
  const action = operationTokens.map((token) => token.toLowerCase()).join('_');
  if (!toolkit || !action) return null;
  const toolId = toolkit + '.' + action;
  return {
    toolId,
    wireName: stableWireName(toolId),
    family: toolkit,
    baselineEffect: category.baselineEffect,
    reversibility: category.reversibility,
    allowedDataLabels: ['public', 'private'],
  };
}

function classifyTokens(
  tokens: string[],
): Pick<ClassifiedTool, 'baselineEffect' | 'reversibility'> | null {
  // Gmail's `send_as` is a resource noun (alias settings), not an outbound
  // SEND action. Remove that compound before applying conservative verb rules.
  const actionTokens = tokens.filter(
    (_token, index) =>
      !(index > 0 && tokens[index] === 'SEND' && tokens[index + 1] === 'AS') &&
      !(index > 1 && tokens[index] === 'AS' && tokens[index - 1] === 'SEND'),
  );
  if (actionTokens.some((token) => DESTRUCTIVE.has(token))) {
    return { baselineEffect: 'destructive', reversibility: 'irreversible' };
  }
  if (actionTokens.some((token) => IRREVERSIBLE_WRITE.has(token))) {
    return { baselineEffect: 'write', reversibility: 'irreversible' };
  }
  if (actionTokens.some((token) => RECOVERABLE_WRITE.has(token))) {
    const sendAsResource = tokens.some(
      (token, index) => token === 'SEND' && tokens[index + 1] === 'AS',
    );
    const sensitiveMutation =
      sendAsResource || tokens.some((token) => APPROVAL_SENSITIVE_NOUNS.has(token));
    return {
      baselineEffect: 'write',
      reversibility: sensitiveMutation ? 'irreversible' : 'recoverable',
    };
  }
  if (actionTokens.some((token) => READ.has(token))) {
    return { baselineEffect: 'read', reversibility: 'reversible' };
  }
  return null;
}

function trustedDescription(tool: ToolboxToolDefinition): string {
  const description = tool.description
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 300);
  return description || 'Composio ' + tool.toolkit + ' operation ' + tool.name;
}

function stableWireName(toolId: string): string {
  const normalized = toolId.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized.length <= 48) return normalized;
  const hash = createHash('sha256').update(toolId).digest('hex').slice(0, 8);
  return normalized.slice(0, 39) + '_' + hash;
}

function normalizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function startsWith(value: string[], prefix: string[]): boolean {
  return prefix.length > 0 && prefix.every((token, index) => value[index] === token);
}

function destinationFrom(value: Json): string | undefined {
  if (!isRecord(value)) return undefined;
  const keys = [
    'recipient_email',
    'to',
    'recipient',
    'to_email',
    'channel',
    'channel_id',
    'calendar_id',
    'spreadsheet_id',
    'document_id',
    'file_id',
    'repo',
    'repository',
    'url',
    'path',
    'id',
  ];
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (Array.isArray(candidate)) {
      const strings = candidate.filter((item): item is string => typeof item === 'string');
      if (strings.length > 0) return strings.join(', ');
    }
  }
  return undefined;
}

function asArguments(value: Json): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Composio arguments must be an object.');
  return value;
}

function exposedInputSchema(tool: ToolboxToolDefinition): Json {
  if (tool.name === 'GMAIL_SEND_EMAIL') return structuredClone(MAIL_SEND_INPUT_SCHEMA);
  if (!tool.inputSchema) throw new Error('Composio tool is missing its trusted input schema.');
  return tool.inputSchema;
}

function providerArguments(toolName: string, value: Json): Record<string, unknown> {
  const args = asArguments(value);
  if (toolName !== 'GMAIL_SEND_EMAIL') return args;
  const { to, ...providerArgs } = args;
  return { ...providerArgs, recipient_email: to };
}

function emptyReport(skipped: string[] = []): ComposioRegistrationReport {
  return { registered: [], skipped: [...skipped], requiresConnection: [] };
}

function failureReport(skipped: string[], warning: string): ComposioRegistrationReport {
  return { ...emptyReport(skipped), warning };
}

function mergeLabels(base: DataLabel[], additions: DataLabel[]): DataLabel[] {
  return [...new Set<DataLabel>([...base, ...additions])];
}

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toJson(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toJson(child)]));
  }
  return String(value);
}
