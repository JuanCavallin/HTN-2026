import type { Capability, ToolboxAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveComposio } from './live.js';

const CAPABILITIES: readonly Capability[] = ['toolbox'];

const TOOLS = [
  {
    name: 'GMAIL_SEND_EMAIL',
    description: 'Send an email through a connected Gmail account',
    version: 'mock-1',
    toolkit: 'gmail',
    inputSchema: {
      type: 'object',
      properties: {
        recipient_email: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['recipient_email', 'subject', 'body'],
      additionalProperties: false,
    },
    requiredScopes: ['https://www.googleapis.com/auth/gmail.send'],
  },
  { name: 'forms.submit', description: 'Submit a web form on the user behalf' },
  { name: 'sheets.append', description: 'Append a row to a spreadsheet ledger' },
  { name: 'calendar.create', description: 'Create a calendar event' },
];

const TOOLKITS = [
  {
    slug: 'gmail',
    name: 'Gmail',
    description: 'Read and send email through Gmail.',
    authSchemes: ['oauth2'],
    toolsCount: 1,
    connected: false,
    noAuth: false,
  },
  {
    slug: 'github',
    name: 'GitHub',
    description: 'Work with repositories, issues, and pull requests.',
    authSchemes: ['oauth2'],
    connected: false,
    noAuth: false,
  },
  {
    slug: 'slack',
    name: 'Slack',
    description: 'Read and send Slack messages.',
    authSchemes: ['oauth2'],
    connected: false,
    noAuth: false,
  },
];

export function create(cfg: ProviderConfig): ToolboxAdapter {
  if (cfg.mode === 'live') return createLiveComposio(cfg);
  return createMock(cfg);
}

function createMock(cfg: ProviderConfig): ToolboxAdapter {
  const base = mockBase('composio', CAPABILITIES, cfg.mode);
  return {
    ...base,
    async listTools(ctx) {
      return mockCall('composio', 'listTools', cfg.mode, ctx, () => TOOLS);
    },
    async searchTools(input, ctx) {
      return mockCall('composio', 'searchTools', cfg.mode, ctx, () => {
        const terms = input.query
          .toLowerCase()
          .split(/\s+/)
          .filter((term) => term.length > 2);
        const toolkits = new Set((input.toolkits ?? []).map((toolkit) => toolkit.toLowerCase()));
        return TOOLS.filter((tool) => {
          const toolkit = 'toolkit' in tool && typeof tool.toolkit === 'string' ? tool.toolkit : '';
          if (toolkits.size > 0 && !toolkits.has(toolkit)) return false;
          const text = (tool.name + ' ' + tool.description).toLowerCase();
          return terms.length === 0 || terms.some((term) => text.includes(term));
        }).slice(0, input.limit ?? 24);
      });
    },
    async listConnectedToolkits(ctx) {
      return mockCall('composio', 'listConnectedToolkits', cfg.mode, ctx, () =>
        TOOLKITS.filter((toolkit) => toolkit.connected || toolkit.noAuth),
      );
    },
    async listToolkitTools(input, ctx) {
      return mockCall('composio', 'listToolkitTools', cfg.mode, ctx, () => {
        const toolkits = new Set(input.toolkits.map((toolkit) => toolkit.toLowerCase()));
        return TOOLS.filter((tool) => {
          const toolkit = 'toolkit' in tool && typeof tool.toolkit === 'string' ? tool.toolkit : '';
          return toolkits.has(toolkit);
        }).slice(0, Math.max(1, input.limitPerToolkit ?? 1_000) * toolkits.size);
      });
    },
    async listToolkits(input, ctx) {
      return mockCall('composio', 'listToolkits', cfg.mode, ctx, () => {
        const query = input.search?.trim().toLowerCase();
        const items = query
          ? TOOLKITS.filter((toolkit) =>
              (toolkit.name + ' ' + toolkit.slug + ' ' + toolkit.description)
                .toLowerCase()
                .includes(query),
            )
          : TOOLKITS;
        return { items: items.slice(0, input.limit ?? 1_000), totalItems: items.length };
      });
    },
    async connectUrl(app, ctx) {
      return mockCall('composio', 'connectUrl', cfg.mode, ctx, () => ({
        url: 'https://example.invalid/oauth/' + encodeURIComponent(app),
      }));
    },
    async callTool(input, ctx) {
      return mockCall('composio', 'callTool', cfg.mode, ctx, () => ({
        tool: input.name,
        status: 'ok',
        receivedArgs: Object.keys(input.args),
      }));
    },
  };
}
