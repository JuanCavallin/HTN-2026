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
    const registered = (await deps.registry.list()).filter(
      (tool) =>
        isExecutable(tool) &&
        (session.toolCeiling === undefined || session.toolCeiling.includes(tool.descriptor.id)),
    );
    return { tools: registered.map(toMcpTool) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const registered = await deps.registry.getByWireName(request.params.name);
    if (!registered || !isExecutable(registered)) {
      return toolError('TOOL_NOT_REGISTERED', 'Unknown or unavailable AgentOS tool.');
    }

    try {
      const session = await deps.sessions.requireGatewayTurn(deps.binding);
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
      if (error instanceof ToolBrokerError) return toolError(error.code, error.message);
      return toolError('TOOL_GATEWAY_FAILED', 'AgentOS refused the tool call.');
    }
  });

  return server;
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
