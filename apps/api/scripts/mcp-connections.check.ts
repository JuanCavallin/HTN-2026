import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpConnectionManager } from '../src/core/mcp/connections.js';
import { InMemoryToolExecutorRegistry } from '../src/core/tools/executors.js';
import { InMemoryToolRegistry } from '../src/core/tools/registry.js';
import { createMemoryStore } from '../src/store/memory.js';

const app = express();
app.use(express.json());
app.post('/mcp', async (req, res) => {
  const server = new Server(
    { name: 'connection-check-server', version: '1' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search_records',
        description: 'Provider-controlled description is not trusted.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        name: 'delete_record',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      {
        name: 'magicalize_record',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text', text: 'result for ' + JSON.stringify(request.params.arguments) }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  try {
    await transport.handleRequest(req, res, req.body);
  } finally {
    await transport.close();
    await server.close();
  }
});
app.get('/mcp', (_req, res) => res.status(405).end());
app.delete('/mcp', (_req, res) => res.status(405).end());

const listener = app.listen(0, '127.0.0.1');
await once(listener, 'listening');
const address = listener.address();
assert.ok(address && typeof address === 'object');
const endpoint = 'http://127.0.0.1:' + address.port + '/mcp';

try {
  const store = createMemoryStore();
  const registry = new InMemoryToolRegistry();
  const executors = new InMemoryToolExecutorRegistry();
  const egress: string[] = [];
  const manager = new McpConnectionManager(store, registry, executors, async (event) => {
    egress.push(event.op);
  });

  const connection = await manager.create({ name: 'Check server', url: endpoint });
  assert.equal(connection.status, 'connected');
  assert.equal(connection.toolIds.length, 3);
  assert.deepEqual(connection.executableToolIds.sort(), [
    'mcp.check_server.delete_record',
    'mcp.check_server.search_records',
  ]);

  const search = await registry.get('mcp.check_server.search_records');
  const deletion = await registry.get('mcp.check_server.delete_record');
  const unknown = await registry.get('mcp.check_server.magicalize_record');
  assert.equal(search?.descriptor.baselineEffect, 'read');
  assert.equal(search?.descriptor.reversibility, 'reversible');
  assert.equal(deletion?.descriptor.baselineEffect, 'destructive');
  assert.equal(deletion?.descriptor.reversibility, 'irreversible');
  assert.equal(unknown?.descriptor.availability, 'unavailable');
  assert.match(search?.descriptor.description ?? '', /Operation search_records/);
  assert.doesNotMatch(search?.descriptor.description ?? '', /Provider-controlled/);

  assert.ok(search);
  const executor = executors.resolve(search.descriptor.executorRef);
  assert.ok(executor);
  const output = await executor.execute(
    {
      id: 'action_check',
      runId: 'run_check',
      stepId: 'step_check',
      toolId: search.descriptor.id,
      descriptorVersion: search.descriptor.version,
      operation: search.descriptor.id,
      arguments: { query: 'safe query' },
      destination: endpoint,
      dataLabels: ['private'],
      createdAt: new Date().toISOString(),
    },
    { runId: 'run_check', stepId: 'step_check', policyRule: 'mcp-connection-check' },
  );
  assert.equal(output.verified, true);
  assert.deepEqual(egress, ['callTool:search_records']);

  const disabled = await manager.setEnabled(connection.id, false);
  assert.equal(disabled.status, 'disabled');
  assert.equal(await registry.get(search.descriptor.id), null);
  assert.deepEqual(await manager.candidateToolIds(), []);
  assert.equal(await manager.remove(connection.id), true);
  assert.deepEqual(await manager.list(), []);

  console.log(
    'PASS: generic MCP connections discover, classify, execute, disable, and fail closed.',
  );
} finally {
  listener.close();
  await once(listener, 'close');
}
