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
        // Never put Browserbase's interactive debugger URL in agent/tool output.
        // It is minted only for an explicit human handoff.
        liveViewUrl = undefined;
        ownsSession = true;
        sessions.set(sessionId, { providerId, url: requestedUrl, runId: action.runId });
      }

      try {
        if (operation === 'open') {
          ownsSession = false;
          return output(
            action,
            {
              sessionId,
              liveViewUrl: liveViewUrl ?? null,
              backend: providerId,
            },
            'Opened a ' + providerId + ' browser session.',
          );
        }

        if (operation === 'search' || operation === 'extract') {
          const instruction =
            operation === 'search'
              ? 'Return concise search results for: ' + requiredString(args, 'query')
              : requiredString(args, 'instruction');
          const extracted = await adapter.extract<Json>(
            { sessionId, instruction },
            childContext(ctx, 'browser-read'),
          );
          if (!extracted.ok) throw new Error(extracted.error.message);
          return output(
            action,
            extracted.data,
            operation === 'search' ? 'Completed browser search.' : 'Extracted browser content.',
          );
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
  return 'https://www.google.com/search?q=' + encodeURIComponent(query);
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
