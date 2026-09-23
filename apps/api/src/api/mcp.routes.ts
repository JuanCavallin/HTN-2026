import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createAgentOsMcpServer } from '../core/mcp/server.js';
import { sessionStateService, toolBroker, toolRegistry } from '../services/runtime.js';

export const mcpGatewayRouter = Router();

mcpGatewayRouter.use(async (req, res, next) => {
  try {
    const header = req.header('authorization');
    res.locals.gatewayBinding = await sessionStateService.resolveGatewayToken(
      header?.startsWith('Bearer ') ? header.slice(7) : undefined,
      'mcp',
    );
    next();
  } catch {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Invalid AgentOS MCP gateway token.' },
      id: null,
    });
    return;
  }
});

mcpGatewayRouter.post('/', async (req, res) => {
  const server = createAgentOsMcpServer({
    registry: toolRegistry,
    broker: toolBroker,
    sessions: sessionStateService,
    binding: res.locals.gatewayBinding,
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
