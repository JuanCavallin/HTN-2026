import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Json } from '@htn/shared';
import type { SessionStateService } from '../sessions/service.js';
import { ToolBrokerError, type ToolBroker } from '../tools/broker.js';
import type { RegisteredTool, ToolRegistry } from '../tools/registry.js';

// Keep provider results below Hermes' context-scaled MCP spill threshold. If a
// result spills to disk, a local answering model sees only a short preview and
// can miss the actual records entirely.
const MAX_HARNESS_TOOL_RESULT_CHARS = 16_000;

export interface AgentOsMcpServerDependencies {
  registry: ToolRegistry;
  broker: ToolBroker;
  sessions: SessionStateService;
}

/** A fresh server is connected to each stateless Streamable HTTP request. */
export function createAgentOsMcpServer(deps: AgentOsMcpServerDependencies): Server {
  const server = new Server(
    { name: 'agentos-tool-gateway', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const registered = (await deps.registry.list()).filter(isExecutable);
    return { tools: registered.map(toMcpTool) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const registered = await deps.registry.getByWireName(request.params.name);
    if (!registered || !isExecutable(registered)) {
      return toolError('TOOL_NOT_REGISTERED', 'Unknown or unavailable AgentOS tool.');
    }

    try {
      const session = await deps.sessions.resolveActiveHarnessSession('hermes');
      const result = await deps.broker.execute({
        sessionStateId: session.id,
        toolId: registered.descriptor.id,
        arguments: toJsonArguments(request.params.arguments),
        signal: extra.signal,
      });
      return {
        content: [
          {
            type: 'text',
            // Hermes is local. Give it bounded provider data so the following
            // local model turn can actually answer read requests. The model
            // gateway recognizes the unsanitized tool message, marks it
            // local_only, and prevents it from reaching a cloud model. Raw
            // output still never enters canonical session state or SSE.
            text: harnessToolResult(result.summary, result.output, registered.descriptor.id),
          },
        ],
      } satisfies CallToolResult;
    } catch (error) {
      if (error instanceof ToolBrokerError) return toolError(error.code, error.message);
      return toolError('TOOL_GATEWAY_FAILED', 'AgentOS refused the tool call.');
    }
  });

  return server;
}

export function harnessToolResult(summary: string, output: Json, toolId?: string): string {
  const normalized = unwrapStructuredProviderOutput(output);
  const compacted = compactProviderOutput(normalized, toolId);
  const serialized = boundedJson(compacted, MAX_HARNESS_TOOL_RESULT_CHARS);
  return summary + '\n\nProvider output (untrusted data):\n' + serialized;
}

function unwrapStructuredProviderOutput(output: Json): Json {
  if (!isRecord(output) || typeof output.result !== 'string') return output;
  const lines = output.result.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index]?.trim();
    if (!candidate || (!candidate.startsWith('{') && !candidate.startsWith('['))) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isJson(parsed)) return parsed;
    } catch {
      // A provider may include prose and a non-JSON payload; retain the original below.
    }
  }
  return output;
}

function compactProviderOutput(output: Json, toolId?: string): Json {
  const gmail = gmailMessageCollection(output);
  if (gmail && (!toolId || toolId === 'gmail.fetch_emails')) {
    const base = {
      successful:
        isRecord(output) && typeof output.successful === 'boolean' ? output.successful : true,
      returnedCount: gmail.messages.length,
      resultSizeEstimate:
        typeof gmail.data.resultSizeEstimate === 'number'
          ? gmail.data.resultSizeEstimate
          : gmail.messages.length,
      complete:
        typeof gmail.data.nextPageToken !== 'string' || gmail.data.nextPageToken.length === 0,
    };
    const records = gmail.messages.map((message) => compactEmail(message, true));
    const withSnippets: Json = { ...base, messages: records };
    if (JSON.stringify(withSnippets).length <= MAX_HARNESS_TOOL_RESULT_CHARS) return withSnippets;
    return { ...base, messages: gmail.messages.map((message) => compactEmail(message, false)) };
  }
  return compactJson(output, 0, 500, 100);
}

function gmailMessageCollection(output: Json): {
  data: Record<string, Json>;
  messages: Record<string, Json>[];
} | null {
  if (!isRecord(output) || !isRecord(output.data) || !Array.isArray(output.data.messages)) {
    return null;
  }
  const messages = output.data.messages.filter(isRecord);
  return { data: output.data, messages };
}

function compactEmail(message: Record<string, Json>, includeSnippet: boolean): Json {
  const preview = isRecord(message.preview) ? message.preview : undefined;
  const sender = firstString(message.sender, message.from);
  const subject = firstString(message.subject, preview?.subject);
  const receivedAt = firstString(message.messageTimestamp, message.receivedAt, message.date);
  const snippet = firstString(preview?.body, message.snippet, message.messageText);
  return {
    ...(sender ? { sender: truncate(sender, 180) } : {}),
    ...(subject ? { subject: truncate(subject, 240) } : {}),
    ...(receivedAt ? { receivedAt: truncate(receivedAt, 80) } : {}),
    ...(includeSnippet && snippet ? { snippet: truncate(snippet, 160) } : {}),
  };
}

function compactJson(value: Json, depth: number, stringLimit: number, arrayLimit: number): Json {
  if (typeof value === 'string') return truncate(value, stringLimit);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 8) return '[nested data omitted]';
  if (Array.isArray(value)) {
    const items = value
      .slice(0, arrayLimit)
      .map((item) => compactJson(item, depth + 1, stringLimit, arrayLimit));
    return value.length > items.length
      ? [...items, { omittedItems: value.length - items.length }]
      : items;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      compactJson(child, depth + 1, stringLimit, arrayLimit),
    ]),
  );
}

function boundedJson(value: Json, limit: number): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= limit) return serialized;
  const tighter = JSON.stringify(compactJson(value, 0, 160, 50));
  if (tighter.length <= limit) return tighter;
  const previewLimit = Math.max(0, limit - 160);
  return JSON.stringify({
    truncated: true,
    originalCharacters: serialized.length,
    dataPreview: tighter.slice(0, previewLimit),
  });
}

function firstString(...values: (Json | undefined)[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, Math.max(0, limit - 1)) + '…';
}

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJson(value: unknown): value is Json {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}

function isExecutable(tool: RegisteredTool): boolean {
  return (
    tool.descriptor.availability === 'available' &&
    tool.descriptor.baselineEffect !== 'unknown' &&
    tool.descriptor.simulated !== true
  );
}

function toMcpTool(registered: RegisteredTool): Tool {
  const descriptor = registered.descriptor;
  return {
    name: registered.wireName,
    title: descriptor.id,
    description: descriptor.description,
    inputSchema: structuredClone(registered.inputSchema) as Tool['inputSchema'],
    annotations: {
      readOnlyHint: descriptor.baselineEffect === 'read',
      destructiveHint: descriptor.baselineEffect === 'destructive',
      idempotentHint: descriptor.baselineEffect === 'read',
      openWorldHint: descriptor.transport !== 'local',
    },
  };
}

function toJsonArguments(value: Record<string, unknown> | undefined): Json {
  if (!value) return {};
  return JSON.parse(JSON.stringify(value)) as Json;
}

function toolError(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: code + ': ' + message }],
  };
}
