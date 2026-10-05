import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Json } from '@htn/shared';
import type { GatewayTurnBinding, SessionStateService } from '../sessions/service.js';
import { ToolBrokerError, type ToolBroker } from '../tools/broker.js';
import type { RegisteredTool, ToolRegistry } from '../tools/registry.js';
import { modelToolText } from '../tools/executors.js';
import { compactSummary } from '../modelGateway/service.js';

export interface AgentOsMcpServerDependencies {
  registry: ToolRegistry;
  broker: ToolBroker;
  sessions: SessionStateService;
  binding: GatewayTurnBinding;
}

/** A fresh server is connected to each stateless Streamable HTTP request. */
export function createAgentOsMcpServer(deps: AgentOsMcpServerDependencies): Server {
  const server = new Server(
    { name: 'agentos-tool-gateway', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const session = await deps.sessions.requireGatewayTurn(deps.binding);
    const allowedIds = new Set(session.taskToolIds ?? session.candidateToolIds);
    const registered = (await deps.registry.list()).filter(
      (tool) =>
        isExecutable(tool) &&
        allowedIds.has(tool.descriptor.id) &&
        (!session.boundBrowserSessionId || !isSeparateBrowserOperation(tool.descriptor.id)) &&
        (session.toolCeiling === undefined || session.toolCeiling.includes(tool.descriptor.id)),
    );
    return { tools: registered.map(toMcpTool) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const registered = await deps.registry.getByWireName(request.params.name);
    if (!registered || !isExecutable(registered)) {
      return toolError('TOOL_NOT_REGISTERED', 'Unknown or unavailable AgentOS tool.');
    }

    let sessionId: string | undefined;
    try {
      const session = await deps.sessions.requireGatewayTurn(deps.binding);
      sessionId = session.id;
      const result = await deps.broker.execute({
        sessionStateId: session.id,
        expectedTurn: deps.binding.turn,
        toolId: registered.descriptor.id,
        arguments: toJsonArguments(request.params.arguments),
        signal: extra.signal,
      });
      return {
        content: [
          {
            type: 'text',
            // Raw provider output stays local. Hermes receives only the compact broker summary,
            // or the explicitly sanitized version when an executor supplied one.
            text: modelToolText(result),
          },
        ],
      } satisfies CallToolResult;
    } catch (error) {
      if (!(error instanceof ToolBrokerError)) {
        return toolError('TOOL_GATEWAY_FAILED', 'AgentOS refused the tool call.');
      }
      const failed = toolError(error.code, error.message);
      if (sessionId) await recordTrustedError(deps.sessions, sessionId, failed);
      return failed;
    }
  });

  return server;
}

function isSeparateBrowserOperation(toolId: string): boolean {
  return (
    (toolId.startsWith('browserbase.') || toolId.startsWith('localbrowser.')) &&
    ['open', 'search', 'read'].includes(toolId.slice(toolId.lastIndexOf('.') + 1))
  );
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

/**
 * Record a broker error as a trusted public tool result, so the model gateway
 * can match Hermes's echo of it. Without this, one failed call in a public
 * session was labelled local_only, which spread to the session and blocked
 * every cloud model for the rest of the run, including later graph nodes.
 * Only for all-public sessions: a non-public session's error may carry its
 * data, so its echo stays local_only (the fail-safe default).
 */
async function recordTrustedError(
  sessions: SessionStateService,
  sessionId: string,
  failed: CallToolResult,
): Promise<void> {
  const session = await sessions.get(sessionId);
  if (!session || !session.dataLabels.every((label) => label === 'public')) return;
  const [first] = failed.content;
  if (first?.type !== 'text') return;
  const summary = compactSummary(first.text);
  await sessions.appendContext(sessionId, [
    { role: 'tool', summary, sanitizedSummary: summary, dataLabels: ['public'] },
  ]);
}

function toolError(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: code + ': ' + message }],
  };
}
