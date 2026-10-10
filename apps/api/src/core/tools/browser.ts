import type {
  BrowserAdapter,
  BrowserOperation,
  DataLabel,
  ElementTable,
  Json,
  ProviderCallContext,
  ToolAction,
} from '@htn/shared';
import { BROWSERBASE_API_DESTINATION, LOCAL_BROWSER_DESTINATION } from '@htn/shared';
import type { BrowserDecider } from './browserDecision.js';
import { LOW_CONFIDENCE_THRESHOLD } from './browserDecision.js';
import type { ToolExecutionOutput, ToolExecutor } from './executors.js';

export const BROWSER_EXECUTOR_REF = 'native://browser';

export interface BrowserExecutorDeps {
  provider(capability: 'browser' | 'browser.local'): BrowserAdapter;
  decide: BrowserDecider;
  maxElements?: number;
}

export interface BrowserToolExecutor extends ToolExecutor {
  closeRunSessions(runId: string, ctx: ProviderCallContext): Promise<void>;
}

interface BrowserSession {
  providerId: 'localbrowser' | 'browserbase';
  runId: string;
  url?: string;
}

/**
 * Port of the teammate browser controller onto AgentOS's exact-action broker.
 * Authorization, approval, version pinning, and lifecycle events happen once
 * in ToolBroker; this executor owns only browser I/O and target resolution.
 */
export function createBrowserExecutor(deps: BrowserExecutorDeps): BrowserToolExecutor {
  const sessions = new Map<string, BrowserSession>();

  return {
    ref: BROWSER_EXECUTOR_REF,

    async closeRunSessions(runId, ctx) {
      const owned = [...sessions.entries()].filter(([, session]) => session.runId === runId);
      await Promise.all(
        owned.map(async ([sessionId, session]) => {
          const adapter = deps.provider(
            session.providerId === 'localbrowser' ? 'browser.local' : 'browser',
          );
          try {
            const closed = await adapter.closeSession(
              sessionId,
              childContext(ctx, 'browser-run-release'),
            );
            if (!closed.ok) throw new Error(closed.error.message);
          } finally {
            sessions.delete(sessionId);
          }
        }),
      );
    },

    destinationFor({ descriptor }) {
      if (descriptor.providerId === 'localbrowser') return LOCAL_BROWSER_DESTINATION;
      if (descriptor.providerId === 'browserbase') return BROWSERBASE_API_DESTINATION;
      return undefined;
    },

    async execute(action, ctx) {
      const providerId = providerFor(action.toolId);
      const adapter = deps.provider(providerId === 'localbrowser' ? 'browser.local' : 'browser');
      const args = asObject(action.arguments);
      const operation = action.toolId.split('.').at(-1);
      if (!operation) throw new Error('Browser operation is missing.');

      if (operation === 'close') {
        const sessionId = requiredString(args, 'sessionId');
        assertSessionProvider(sessions, sessionId, providerId);
        const closed = await adapter.closeSession(sessionId, ctx);
        if (!closed.ok) throw new Error(closed.error.message);
        sessions.delete(sessionId);
        return output(action, { closed: sessionId }, 'Closed browser session.');
      }

      const requestedUrl = requestedStartUrl(operation, args);
      assertSensitiveDestination(action.dataLabels, requestedUrl);

      const suppliedSessionId = optionalString(args, 'sessionId');
      let sessionId = suppliedSessionId;
      let ownsSession = false;
      let liveViewUrl: string | undefined;

      if (sessionId) {
        assertSessionProvider(sessions, sessionId, providerId);
        assertSensitiveDestination(action.dataLabels, sessions.get(sessionId)?.url);
      } else {
        const opened = await adapter.openSession(
          requestedUrl ? { startUrl: requestedUrl } : {},
          childContext(ctx, 'browser-session-open'),
        );
        if (!opened.ok) throw new Error('Could not open browser session: ' + opened.error.message);
        sessionId = opened.data.sessionId;
        liveViewUrl = opened.data.liveViewUrl;
        ownsSession = true;
        sessions.set(sessionId, { providerId, url: requestedUrl, runId: action.runId });
      }

      try {
        if (operation === 'open') {
          ownsSession = false;
          const openedPage = requestedUrl
            ? await adapter.extract<Json>(
                {
                  sessionId,
                  // The local adapter is deterministic and treats this field as
                  // a CSS scope. An empty scope returns the visible body plus
                  // the page title/current URL; remote browser providers can
                  // accept the richer natural-language instruction.
                  instruction:
                    providerId === 'localbrowser'
                      ? 'h1'
                      : 'Return a compact JSON object containing the page title, visible H1 headings, and current URL.',
                },
                childContext(ctx, 'browser-open-read'),
              )
            : undefined;
          const page = openedPage?.ok
            ? normalizeOpenedPage(providerId, openedPage.data)
            : undefined;
          const h1 = page && typeof page === 'object' && !Array.isArray(page) ? page.h1 : undefined;
          const publicPageSummary =
            page !== undefined && action.dataLabels.every((label) => label === 'public')
              ? (typeof h1 === 'string' ? ' The visible H1 text is "' + h1 + '".' : '') +
                ' Opened page content: ' +
                compactJson(page)
              : '';
          return output(
            action,
            {
              sessionId,
              liveViewUrl: liveViewUrl ?? null,
              backend: providerId,
              ...(page !== undefined ? { page } : {}),
            },
            'Opened a ' + providerId + ' browser session.' + publicPageSummary,
          );
        }

        if (operation === 'search' || operation === 'extract') {
          const instruction =
            operation === 'search'
              ? // Both live adapters use deterministic CSS-scoped extraction by
                // default. An empty scope means visible body text; passing a
                // prose instruction here was interpreted as an invalid selector.
                ''
              : localExtractionScope(providerId, requiredString(args, 'instruction'));
          const extracted = await adapter.extract<Json>(
            { sessionId, instruction },
            childContext(ctx, 'browser-read'),
          );
          if (!extracted.ok) throw new Error(extracted.error.message);
          const summary =
            operation === 'search'
              ? 'Completed public web search. Results: ' + compactJson(extracted.data)
              : 'Extracted browser content.';
          return output(action, extracted.data, summary);
        }

        const table = await snapshot(adapter, sessionId, deps.maxElements, ctx);
        if (operation === 'inspect') {
          return output(
            action,
            table as unknown as Json,
            'Inspected ' + table.rows.length.toString() + ' interactive browser controls.',
          );
        }

        if (!['click', 'type', 'submit'].includes(operation)) {
          throw new Error('Unknown browser operation: ' + action.toolId);
        }

        const goal = requiredString(args, 'goal');
        const allowedOperations: BrowserOperation[] =
          operation === 'type' ? ['TYPE_TEXT', 'SELECT'] : ['CLICK'];
        const typedValue = optionalString(args, 'text');
        const decision = await deps.decide({
          goal,
          table,
          allowedOperations,
          ...(typedValue ? { typeText: typedValue } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });

        if (decision.confidence < LOW_CONFIDENCE_THRESHOLD) {
          throw new Error(
            'Browser target confidence ' +
              decision.confidence.toFixed(2) +
              ' is below the execution threshold; refine the goal or request human review.',
          );
        }
        if (decision.index === undefined) {
          throw new Error(
            'Browser decision returned no target (' +
              decision.operation +
              '): ' +
              decision.rationale,
          );
        }
        const target = table.rows.find((row) => row.index === decision.index);
        if (!target) throw new Error('Browser decision returned an index that was not offered.');
        if (!adapter.perform) throw new Error('Browser backend lacks element-level execution.');

        const performed = await adapter.perform(
          {
            sessionId,
            snapshotId: table.snapshotId,
            operation: decision.operation,
            index: decision.index,
            ...(typedValue !== undefined ? { text: typedValue } : {}),
          },
          childContext(ctx, 'browser-element-action'),
        );
        if (!performed.ok) throw new Error(performed.error.message);
        sessions.set(sessionId, { providerId, url: performed.data.url, runId: action.runId });

        return output(
          action,
          {
            ...performed.data,
            target: target.label,
            decisionSource: decision.source,
            confidence: decision.confidence,
            rationale: decision.rationale,
          },
          'Completed ' + operation + ' on browser target "' + target.label + '".',
        );
      } finally {
        if (ownsSession) {
          await adapter
            .closeSession(sessionId, childContext(ctx, 'browser-session-release'))
            .catch(() => undefined);
          sessions.delete(sessionId);
        }
      }
    },
  };
}

function providerFor(toolId: string): BrowserSession['providerId'] {
  if (toolId.startsWith('localbrowser.')) return 'localbrowser';
  if (toolId.startsWith('browserbase.')) return 'browserbase';
  throw new Error('Unknown browser provider for tool: ' + toolId);
}

function requestedStartUrl(operation: string, args: Record<string, Json>): string | undefined {
  const explicit = optionalString(args, 'url');
  if (explicit) return normalizeBrowserUrl(explicit);
  if (operation !== 'search') return undefined;
  const query = requiredString(args, 'query');
  // Browser search is an explicit visual-browser fallback. Bing is used here
  // because Google commonly challenges headless sessions before results load.
  // Normal factual lookups route to the grounded `web.search` API instead.
  return 'https://www.bing.com/search?q=' + encodeURIComponent(query);
}

function normalizeBrowserUrl(value: string): string {
  if (value === 'about:blank') return value;
  const parsed = new URL(value);
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    throw new Error('Browser URLs must use http, https, file, or about:blank.');
  }
  return parsed.toString();
}

function assertSensitiveDestination(labels: DataLabel[], url: string | undefined): void {
  if (!labels.some((label) => label === 'secret' || label === 'local_only')) return;
  if (!url) throw new Error('Sensitive browser work requires a known local destination.');
  if (url === 'about:blank' || url.startsWith('file:')) return;
  const hostname = new URL(url).hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    throw new Error('Secret or local-only browser data cannot be sent to a remote website.');
  }
}

function assertSessionProvider(
  sessions: Map<string, BrowserSession>,
  sessionId: string,
  providerId: BrowserSession['providerId'],
): void {
  const known = sessions.get(sessionId);
  if (known && known.providerId !== providerId) {
    throw new Error('Browser session belongs to a different backend.');
  }
}

async function snapshot(
  adapter: BrowserAdapter,
  sessionId: string,
  maxElements: number | undefined,
  ctx: ProviderCallContext,
): Promise<ElementTable> {
  if (!adapter.snapshot) throw new Error('Browser backend lacks element snapshots.');
  const result = await adapter.snapshot(
    { sessionId, ...(maxElements ? { maxElements } : {}) },
    childContext(ctx, 'browser-snapshot'),
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

function output(action: ToolAction, value: Json, summary: string): ToolExecutionOutput {
  const publicOnly = action.dataLabels.every((label) => label === 'public');
  return {
    output: value,
    summary,
    ...(publicOnly ? { sanitizedSummary: summary } : {}),
    dataLabels: [...action.dataLabels],
    verified: true,
  };
}

function compactJson(value: Json): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= 1_500 ? serialized : serialized.slice(0, 1_497) + '...';
}

function normalizeOpenedPage(providerId: BrowserSession['providerId'], value: Json): Json {
  if (
    providerId !== 'localbrowser' ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return value;
  }
  const text = typeof value.text === 'string' ? value.text.trim() : undefined;
  return { ...value, ...(text ? { h1: text } : {}) };
}

function localExtractionScope(
  providerId: BrowserSession['providerId'],
  instruction: string,
): string {
  if (providerId !== 'localbrowser') return instruction;
  if (/\bh1\b|primary\s+heading/i.test(instruction)) return 'h1';
  if (/\bheadings?\b/i.test(instruction)) return 'h1, h2, h3, h4, h5, h6';
  return '';
}

function childContext(ctx: ProviderCallContext, policyRule: string): ProviderCallContext {
  return { ...ctx, policyRule };
}

function asObject(value: Json): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Browser tool arguments must be an object.');
  }
  return value;
}

function requiredString(value: Record<string, Json>, key: string): string {
  const result = optionalString(value, key);
  if (!result) throw new Error('Browser argument "' + key + '" is required.');
  return result;
}

function optionalString(value: Record<string, Json>, key: string): string | undefined {
  const item = value[key];
  return typeof item === 'string' && item.trim() ? item.trim() : undefined;
}
