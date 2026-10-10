import assert from 'node:assert/strict';
import type {
  ProviderCallContext,
  ProviderResult,
  ToolboxAdapter,
  ToolboxToolDefinition,
  ToolAction,
} from '@htn/shared';
import type { ProviderConfig } from '../src/config.js';
import { InMemoryToolExecutorRegistry } from '../src/core/tools/executors.js';
import { InMemoryToolRegistry } from '../src/core/tools/registry.js';
import { explicitConnectedToolkitIds, requiredToolIdsForGoal } from '../src/core/orchestrator.js';
import { createLiveComposio } from '../src/providers/composio/live.js';
import {
  catalogIntentQuery,
  classifyComposioTool,
  ComposioToolCatalog,
} from '../src/providers/composio/register.js';

const send = definition('GMAIL_SEND_EMAIL', 'gmail');
const profile = definition('GMAIL_GET_PROFILE', 'gmail');
const remove = definition('GITHUB_DELETE_REPOSITORY', 'github');
const unknown = definition('GMAIL_MAGICALIZE_EMAIL', 'gmail');
const calendarEvent = definition('GOOGLECALENDAR_CREATE_EVENT', 'googlecalendar');

assert.deepEqual(classifyComposioTool(send), {
  toolId: 'mail.send',
  wireName: 'mail_send',
  family: 'mail',
  baselineEffect: 'write',
  reversibility: 'irreversible',
  allowedDataLabels: ['public', 'private'],
});
assert.equal(classifyComposioTool(profile)?.baselineEffect, 'read');
assert.equal(classifyComposioTool(profile)?.toolId, 'gmail.get_profile');
assert.equal(classifyComposioTool(remove)?.baselineEffect, 'destructive');
assert.equal(
  classifyComposioTool(definition('GMAIL_IMPORT_MESSAGE', 'gmail'))?.reversibility,
  'recoverable',
);
assert.equal(
  classifyComposioTool(definition('GMAIL_LIST_SEND_AS', 'gmail'))?.baselineEffect,
  'read',
);
assert.equal(
  classifyComposioTool(definition('GMAIL_SETTINGS_SEND_AS_GET', 'gmail'))?.baselineEffect,
  'read',
);
assert.deepEqual(
  {
    effect: classifyComposioTool(definition('GMAIL_PATCH_SEND_AS', 'gmail'))?.baselineEffect,
    reversibility: classifyComposioTool(definition('GMAIL_PATCH_SEND_AS', 'gmail'))?.reversibility,
  },
  { effect: 'write', reversibility: 'irreversible' },
);
assert.equal(classifyComposioTool(unknown), null, 'unknown operations must fail closed');
assert.deepEqual(
  {
    effect: classifyComposioTool(calendarEvent)?.baselineEffect,
    reversibility: classifyComposioTool(calendarEvent)?.reversibility,
  },
  { effect: 'write', reversibility: 'irreversible' },
);
assert.equal(
  catalogIntentQuery('Send an email to [[PII_1]] with content: lets lock in'),
  'Send an email',
);

const searched: string[] = [];
const called: string[] = [];
const calledArgs: Record<string, unknown>[] = [];
const adapter: ToolboxAdapter = {
  id: 'composio',
  mode: 'live',
  capabilities: ['toolbox'],
  health: async () => ok('health', {}),
  invoke: async () => ok('invoke', null as never),
  listTools: async () => ok('listTools', [send]),
  searchTools: async (input) => {
    searched.push(input.query);
    return ok('searchTools', [send, profile, unknown]);
  },
  listConnectedToolkits: async () =>
    ok('listConnectedToolkits', [
      {
        slug: 'gmail',
        name: 'Gmail',
        authSchemes: ['oauth2'],
        connected: true,
        noAuth: false,
      },
      {
        slug: 'googlecalendar',
        name: 'Google Calendar',
        authSchemes: ['oauth2'],
        connected: true,
        noAuth: false,
      },
    ]),
  listToolkitTools: async (input) =>
    ok(
      'listToolkitTools',
      input.toolkits.includes('googlecalendar') ? [calendarEvent] : [send, profile, unknown],
    ),
  listToolkits: async () =>
    ok('listToolkits', {
      items: [
        {
          slug: 'gmail',
          name: 'Gmail',
          authSchemes: ['oauth2'],
          connected: true,
          noAuth: false,
        },
      ],
    }),
  connectUrl: async () => ok('connectUrl', { url: 'https://example.invalid/connect' }),
  callTool: async (input) => {
    called.push(input.name + '@' + input.version);
    calledArgs.push(input.args);
    return ok('callTool', { successful: true });
  },
};
const cfg: ProviderConfig = {
  mode: 'live',
  keyVar: 'COMPOSIO_API_KEY',
  userId: 'check-user',
  discoveryLimit: 24,
};
const registry = new InMemoryToolRegistry();
const executors = new InMemoryToolExecutorRegistry();
const catalog = new ComposioToolCatalog(adapter, cfg, registry, executors);
const report = await catalog.discoverForTask({
  query: 'read my profile and send an email',
  runId: 'run_check',
});

assert.deepEqual(searched, ['read my profile and send an email']);
assert.deepEqual(report.registered.sort(), ['gmail.get_profile', 'mail.send']);
assert.deepEqual(report.skipped, ['GMAIL_MAGICALIZE_EMAIL']);
assert.deepEqual(report.requiresConnection, []);

const connected = await catalog.connectedToolkits({ runId: 'run_connected_check' });
assert.deepEqual(
  connected.toolkits.map((toolkit) => toolkit.slug),
  ['gmail', 'googlecalendar'],
);
assert.deepEqual(
  explicitConnectedToolkitIds(
    'send a coffee invite to juancavallin@gmail.com using calendar',
    connected.toolkits,
  ),
  ['googlecalendar'],
  'an email address must not be mistaken for an explicit Gmail constraint',
);
const importedCalendar = await catalog.importToolkits({
  toolkits: ['googlecalendar'],
  runId: 'run_calendar_import',
});
assert.deepEqual(importedCalendar.registered, ['googlecalendar.create_event']);

const registered = await registry.get('mail.send');
assert.ok(registered);
assert.equal(registered.descriptor.availability, 'available');
assert.deepEqual(registered.inputSchema, {
  type: 'object',
  properties: {
    to: { type: 'string', description: 'Primary recipient email address.' },
    subject: {
      type: 'string',
      description: 'Optional email subject. Omit it when the user did not provide one.',
    },
    body: { type: 'string', description: 'Email body exactly as requested by the user.' },
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
});
const executor = executors.resolve(registered.descriptor.executorRef);
assert.ok(executor);
const action: ToolAction = {
  id: 'act_check',
  runId: 'run_check',
  stepId: 'step_check',
  toolId: registered.descriptor.id,
  descriptorVersion: registered.descriptor.version,
  operation: registered.descriptor.id,
  arguments: { to: 'demo@example.com', body: 'Test body' },
  destination: 'demo@example.com',
  dataLabels: ['private'],
  createdAt: new Date().toISOString(),
};
assert.equal(
  executor.destinationFor({ descriptor: registered.descriptor, arguments: action.arguments }),
  'demo@example.com',
);
await executor.execute(action, context('run_check'));
assert.deepEqual(called, ['GMAIL_SEND_EMAIL@20260915_00']);
assert.deepEqual(calledArgs, [{ recipient_email: 'demo@example.com', body: 'Test body' }]);

const registeredCalendar = await registry.get('googlecalendar.create_event');
assert.ok(registeredCalendar);
assert.equal(registeredCalendar.descriptor.reversibility, 'irreversible');
assert.ok(
  registeredCalendar.inputSchema !== null &&
    typeof registeredCalendar.inputSchema === 'object' &&
    !Array.isArray(registeredCalendar.inputSchema),
);
assert.deepEqual(registeredCalendar.inputSchema.required, [
  'summary',
  'start_datetime',
  'event_duration_minutes',
  'timezone',
  'attendees',
]);
assert.deepEqual(
  requiredToolIdsForGoal(
    'send a calendar invite',
    [
      registeredCalendar.descriptor,
      {
        ...registeredCalendar.descriptor,
        id: 'localbrowser.open',
        providerId: 'localbrowser',
        family: 'browser',
        baselineEffect: 'read',
      },
    ],
    ['googlecalendar.create_event'],
    true,
  ),
  ['googlecalendar.create_event'],
);
const calendarExecutor = executors.resolve(registeredCalendar.descriptor.executorRef);
assert.ok(calendarExecutor);
await calendarExecutor.execute(
  {
    ...action,
    id: 'act_calendar_check',
    toolId: 'googlecalendar.create_event',
    descriptorVersion: registeredCalendar.descriptor.version,
    operation: 'googlecalendar.create_event',
    arguments: {
      summary: 'Coffee chat',
      start_datetime: '2026-09-21T14:00:00',
      event_duration_minutes: 15,
      timezone: 'America/Toronto',
      attendees: ['demo@example.com'],
    },
  },
  context('run_calendar_check'),
);
assert.deepEqual(called.at(-1), 'GOOGLECALENDAR_CREATE_EVENT@20260915_00');
assert.deepEqual(calledArgs.at(-1), {
  summary: 'Coffee chat',
  start_datetime: '2026-09-21T14:00:00',
  event_duration_minutes: 15,
  timezone: 'America/Toronto',
  attendees: ['demo@example.com'],
  calendar_id: 'primary',
  send_updates: 'all',
  create_meeting_room: false,
});

const originalFetch = globalThis.fetch;
const requestedUrls: string[] = [];
try {
  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes('/connected_accounts?')) {
      return Response.json({
        items: [
          {
            id: 'ca_test',
            user_id: 'check-user',
            status: 'ACTIVE',
            toolkit: { slug: 'gmail' },
          },
        ],
      });
    }
    if (url.includes('/api/v3.1/tools?')) {
      return Response.json({
        items: [
          {
            slug: 'GMAIL_GET_PROFILE',
            version: '20260915_00',
            description: 'Get profile',
            toolkit: { slug: 'gmail' },
            input_parameters: { type: 'object', properties: {} },
            scopes: ['scope:test'],
          },
        ],
      });
    }
    if (url.includes('/api/v3.1/toolkits?')) {
      return Response.json({
        items: [
          {
            slug: 'gmail',
            name: 'Gmail',
            auth_schemes: ['oauth2'],
            composio_managed_auth_schemes: ['oauth2'],
            no_auth: false,
            meta: { description: 'Email', tools_count: 42 },
          },
          {
            slug: 'calculator',
            name: 'Calculator',
            no_auth: true,
            meta: { description: 'Calculate', tools_count: 3 },
          },
        ],
        total_items: 2,
      });
    }
    if (url.endsWith('/api/v3.1/tool_router/session')) {
      return Response.json({ session_id: 'trs_test' }, { status: 201 });
    }
    if (url.endsWith('/api/v3.1/tool_router/session/trs_test/link')) {
      return Response.json({ redirect_url: 'https://app.composio.dev/link/test' }, { status: 201 });
    }
    if (url.includes('/api/v3.1/tools/execute/')) {
      return Response.json({ successful: true });
    }
    throw new Error('Unexpected URL: ' + url);
  };
  const live = createLiveComposio({
    ...cfg,
    apiKey: 'not-a-real-key',
    baseUrl: 'https://composio.example',
  });
  const connectedToolkits = await live.listConnectedToolkits(
    context('run_connected_toolkits_check'),
  );
  assert.equal(connectedToolkits.ok, true);
  if (connectedToolkits.ok) {
    assert.deepEqual(
      connectedToolkits.data.map((toolkit) => toolkit.slug),
      ['gmail'],
    );
  }
  const connectedTools = await live.listToolkitTools(
    { toolkits: ['gmail'], limitPerToolkit: 100 },
    context('run_connected_tools_check'),
  );
  assert.equal(connectedTools.ok, true);
  if (connectedTools.ok) {
    assert.deepEqual(
      connectedTools.data.map((tool) => tool.name),
      ['GMAIL_GET_PROFILE'],
    );
  }
  assert.equal(
    requestedUrls.some(
      (url) =>
        url.includes('/api/v3.1/tools?') &&
        url.includes('toolkit_slug=gmail') &&
        !url.includes('query='),
    ),
    true,
    'connected-tool import must list toolkit metadata without prompt search',
  );
  const discovered = await live.searchTools(
    { query: 'private-looking query', toolkits: ['gmail'], limit: 1 },
    context('run_live_adapter_check'),
  );
  assert.equal(discovered.ok, true);
  assert.equal((discovered.meta.destination ?? '').includes('private-looking'), false);
  assert.equal(
    requestedUrls.some((url) => url.includes('query=private-looking+query')),
    true,
  );
  const toolkits = await live.listToolkits({ limit: 1_000 }, context('run_toolkits_check'));
  assert.equal(toolkits.ok, true);
  if (toolkits.ok) {
    assert.equal(toolkits.data.items.length, 2);
    assert.equal(toolkits.data.items.find((item) => item.slug === 'gmail')?.connected, true);
    assert.equal(toolkits.data.items.find((item) => item.slug === 'calculator')?.connected, true);
  }
  const link = await live.connectUrl('github', context('run_connect_check'));
  assert.equal(link.ok, true);
  if (link.ok) assert.equal(link.data.url, 'https://app.composio.dev/link/test');
  assert.equal(
    requestedUrls.some((url) => url.endsWith('/api/v3.1/tool_router/session/trs_test/link')),
    true,
  );
  const executed = await live.callTool(
    { name: 'GMAIL_GET_PROFILE', version: '20260915_00', args: {} },
    context('run_live_adapter_check'),
  );
  assert.equal(executed.ok, true);
  const untrusted = await live.callTool(
    { name: 'GMAIL_UNKNOWN', version: '1', args: {} },
    context('run_live_adapter_check'),
  );
  assert.equal(untrusted.ok, false, 'unresolved provider tool must not execute');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('composio catalog checks passed');

function definition(name: string, toolkit: string): ToolboxToolDefinition {
  return {
    name,
    toolkit,
    version: '20260915_00',
    description: name,
    inputSchema: {
      type: 'object',
      properties: { recipient_email: { type: 'string' } },
      additionalProperties: false,
    },
    requiredScopes: ['scope:test'],
    connectedAccountId: 'ca_test',
  };
}

function context(runId: string): ProviderCallContext {
  return { runId, policyRule: 'catalog-check' };
}

function ok<T>(op: string, data: T): ProviderResult<T> {
  return {
    ok: true,
    data,
    meta: {
      provider: 'composio',
      op,
      mode: 'live',
      latencyMs: 0,
      destination: 'mock://composio-check',
    },
  };
}
