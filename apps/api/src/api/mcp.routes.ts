import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config.js';
import { createAgentOsMcpServer } from '../core/mcp/server.js';
import { sessionStateService, toolBroker, toolRegistry } from '../services/runtime.js';

export const mcpGatewayRouter = Router();

mcpGatewayRouter.use((req, res, next) => {
  if (!tokenMatches(req.header('authorization'), config.mcpGateway.apiKey)) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Invalid AgentOS MCP gateway token.' },
      id: null,
    });
    return;
  }
  next();
});

mcpGatewayRouter.post('/', async (req, res) => {
  const server = createAgentOsMcpServer({
    registry: toolRegistry,
    broker: toolBroker,
    sessions: sessionStateService,
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[mcp] request failed:', error instanceof Error ? error.message : error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'AgentOS MCP request failed.' },
        id: null,
      });
    }
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

for (const method of ['get', 'delete'] as const) {
  mcpGatewayRouter[method]('/', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed for stateless AgentOS MCP.' },
      id: null,
    });
  });
}

function tokenMatches(authorization: string | undefined, expected: string): boolean {
  if (!authorization?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(authorization.slice('Bearer '.length));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}
