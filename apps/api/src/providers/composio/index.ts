import type { Capability, ToolboxAdapter, ToolCatalogEntry } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveComposio } from './live.js';

const CAPABILITIES: readonly Capability[] = ['toolbox'];

/**
 * The catalog.
 *
 * These are the tools THIS REPO ALREADY REFERENCED — `demo.playbook.ts`,
 * `demo.graph.ts`, and the hardcoded table that used to live in
 * `core/graph/toolRisk.ts`. Nothing here is invented to pad a number.
 *
 * `actionKind` is the addition, and it is a SAFETY field: `core/risk.ts`
 * decides whether a human is asked from the action's kind, and a graph's
 * `dispatch` node does not know which tool it will call until a model picks
 * one. So the kind has to travel with the tool. Every value below is one
 * `core/risk.ts` ALREADY recognises — a kind it does not know falls through to
 * `reversible` and runs unattended, which is the failure that matters.
 *
 * Deterministic on purpose: a rehearsed demo shows the same catalog every time.
 *
 * GROWING THIS LIST is deliberately deferred until the sponsor APIs are chosen
 * (`3A-6`). When that happens each addition is one manifest plus one executor
 * binding, and anything without a real provider behind it must carry
 * `simulated: true` and refuse to execute.
 */
const TOOLS: ToolCatalogEntry[] = [
  // Reads. Reversible, so they run automatically.
  {
    name: 'browser.navigate',
    description: 'Open a URL in a browser session.',
    actionKind: 'read_page',
    group: 'browser',
  },
  {
    name: 'browser.extract',
    description: 'Extract text from the current page.',
    actionKind: 'read_page',
    group: 'browser',
  },
  {
    name: 'web.search',
    description: 'Search the public web.',
    actionKind: 'read_page',
    group: 'web',
  },
  {
    name: 'docs.read',
    description: 'Read the contents of a document.',
    actionKind: 'read_page',
    group: 'docs',
  },

  // Recoverable: undoable, but only via a human or a support path.
  {
    name: 'sheets.append',
    description: 'Append a row to a spreadsheet ledger.',
    actionKind: 'update_profile',
    group: 'sheets',
  },
  {
    name: 'calendar.create',
    description: 'Create a calendar event.',
    actionKind: 'schedule',
    group: 'calendar',
  },
  {
    name: 'docs.draft',
    description: 'Create a draft document.',
    actionKind: 'create_draft',
    group: 'docs',
  },

  // Irreversible. These always stop for a human.
  {
    name: 'forms.submit',
    description: 'Submit a web form on the user behalf.',
    actionKind: 'submit_form',
    group: 'browser',
  },
  { name: 'mail.send', description: 'Send an email.', actionKind: 'send_email', group: 'mail' },
  {
    name: 'notify.slack',
    description: 'Post a message to a Slack channel.',
    actionKind: 'send_message',
    group: 'chat',
  },
  {
    name: 'notify.sms',
    description: 'Send an SMS message.',
    actionKind: 'send_message',
    group: 'chat',
  },
  {
    name: 'payments.charge',
    description: 'Charge a payment method.',
    actionKind: 'make_payment',
    group: 'billing',
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
    async connectUrl(app, ctx) {
      return mockCall('composio', 'connectUrl', cfg.mode, ctx, () => ({
        url: 'https://example.invalid/oauth/' + encodeURIComponent(app),
      }));
    },
    async callTool(input, ctx) {
      // A FIXTURE REFUSES TO RUN. The design spec is explicit: simulated tools
      // are "clearly labeled non-executable", and attempting one is an error,
      // not a no-op. A fixture that returns `ok` puts work in the trace that
      // never happened, which is worse than having no fixture at all.
      const entry = TOOLS.find((tool) => tool.name === input.name);
      if (entry?.simulated) {
        return {
          ok: false as const,
          error: {
            code: 'BAD_INPUT' as const,
            message:
              input.name +
              ' is a labelled fixture with no provider behind it. It exists so tool ' +
              'selection can be demonstrated; it cannot be executed.',
            retryable: false,
          },
          meta: {
            provider: 'composio' as const,
            op: 'callTool',
            mode: cfg.mode,
            latencyMs: 0,
            destination: null,
          },
        };
      }

      return mockCall('composio', 'callTool', cfg.mode, ctx, () => ({
        tool: input.name,
        status: 'ok',
        receivedArgs: Object.keys(input.args),
      }));
    },
  };
}
