import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import {
  CORE_RUNTIME_STATUS_TOOL_ID,
  CORE_RUNTIME_STATUS_WIRE_NAME,
} from '../src/core/tools/local.js';
import { sessionStateService, store } from '../src/services/runtime.js';

async function main(): Promise<void> {
  const session = await sessionStateService.create({
    runId: 'mcp_gateway_check',
    stepId: 'mcp_gateway_check_step',
    harness: 'hermes',
    objective: 'Read the current AgentOS runtime status.',
    sanitizedObjective: 'Read the current AgentOS runtime status.',
    dataLabels: ['public'],
    budget: { stepsRemaining: 2 },
    candidateToolIds: [CORE_RUNTIME_STATUS_TOOL_ID],
  });
  await sessionStateService.beginTurn(session.id);
  await sessionStateService.grantToolExposure(session.id, {
    modelCallId: 'chatcmpl_mcp_gateway_check',
    selectedToolVersions: { [CORE_RUNTIME_STATUS_TOOL_ID]: '1' },
  });

  const listener = createApp().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = new URL('http://127.0.0.1:' + address.port + '/mcp');

  try {
    const unauthorized = await fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'unauthorized-check', version: '1' },
        },
      }),
    });
    assert.equal(unauthorized.status, 401);

    const client = new Client({ name: 'agentos-mcp-check', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: 'Bearer ' + config.mcpGateway.apiKey } },
    });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      const runtimeTool = listed.tools.find((tool) => tool.name === CORE_RUNTIME_STATUS_WIRE_NAME);
      assert.ok(runtimeTool, 'the real local runtime-status tool must be discoverable');
      assert.equal(runtimeTool.annotations?.readOnlyHint, true);

      const result = await client.callTool({
        name: CORE_RUNTIME_STATUS_WIRE_NAME,
        arguments: {},
      });
      assert.equal(result.isError, undefined);
      assert.match(JSON.stringify(result.content), /AgentOS session is running on turn 1/);

      await sessionStateService.beginTurn(session.id);
      const expired = await client.callTool({
        name: CORE_RUNTIME_STATUS_WIRE_NAME,
        arguments: {},
      });
      assert.equal(expired.isError, true);
      assert.match(JSON.stringify(expired.content), /TOOL_NOT_SELECTED/);
    } finally {
      await client.close();
    }

    const phases = (await store.eventsSince(session.runId, 0)).flatMap((event) =>
      event.event.type === 'tool.lifecycle' ? [event.event.lifecycle.phase] : [],
    );
    assert.deepEqual(phases, ['proposed', 'policy_decided', 'executing', 'succeeded']);
  } finally {
    listener.close();
    await once(listener, 'close');
  }

  console.log(
    'PASS: authenticated Streamable HTTP MCP discovery and exact-action local execution work.',
  );
}

await main();
