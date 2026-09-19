import type { Capability, ToolboxAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveComposio } from './live.js';

const CAPABILITIES: readonly Capability[] = ['toolbox'];

const TOOLS = [
  { name: 'forms.submit', description: 'Submit a web form on the user behalf' },
  { name: 'mail.send', description: 'Send an email' },
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
