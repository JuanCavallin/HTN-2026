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
