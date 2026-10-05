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
  interactive: boolean;
  url?: string;
}

/**
 * Port of the teammate browser controller onto AgentOS's exact-action broker.
 * Authorization, approval, version pinning, and lifecycle events happen once
 * in ToolBroker; this executor owns only browser I/O and target resolution.
 */
export function createBrowserExecutor(deps: BrowserExecutorDeps): BrowserToolExecutor {
  const sessions = new Map<string, BrowserSession>();
  /**
   * One reusable session per run and backend for stateless public research.
   * A session per search/read cost a Browserbase session each (35 in one
   * 7-minute run, each billed at least a minute), which exhausted the plan.
   * Released with the run's other sessions by closeRunSessions.
   */
  const researchPool = new Map<string, string>();
  /** Serializes navigate+read on a pooled session so concurrent calls cannot interleave. */
  const poolTails = new Map<string, Promise<unknown>>();

  function withPoolLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = poolTails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    poolTails.set(key, next);
    void next.finally(() => {
      if (poolTails.get(key) === next) poolTails.delete(key);
    }).catch(() => undefined);
    return next;
  }

  async function pooledResearch(
    adapter: BrowserAdapter,
    providerId: BrowserSession['providerId'],
    action: ToolAction,
    operation: string,
    url: string,
    ctx: ProviderCallContext,
  ): Promise<ToolExecutionOutput> {
    const key = action.runId + ':' + providerId;
    return withPoolLock(key, async () => {
      let sessionId = researchPool.get(key);
      if (sessionId && adapter.navigate) {
        const moved = await adapter.navigate(
          { sessionId, url },
          childContext(ctx, 'browser-research-navigate'),
        );
        if (!moved.ok) {
          // Expired or broken (Browserbase times idle sessions out): replace it.
          await adapter
            .closeSession(sessionId, childContext(ctx, 'browser-session-release'))
            .catch(() => undefined);
          sessions.delete(sessionId);
          researchPool.delete(key);
          sessionId = undefined;
        }
      }
      if (!sessionId) {
        const opened = await adapter.openSession(
          { startUrl: url },
          childContext(ctx, 'browser-session-open'),
        );
        if (!opened.ok) throw new Error('Could not open browser session: ' + opened.error.message);
        sessionId = opened.data.sessionId;
        researchPool.set(key, sessionId);
      }
      sessions.set(sessionId, {
        providerId,
        url,
        runId: action.runId,
        interactive: false,
      });
      return researchOutput(adapter, sessionId, action, operation, ctx);
    });
  }

  return {
    ref: BROWSER_EXECUTOR_REF,

    async closeRunSessions(runId, ctx) {
      // The pooled sessions are in `sessions` too and are closed below.
      for (const key of [...researchPool.keys()]) {
        if (key.startsWith(runId + ':')) researchPool.delete(key);
      }
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
          } catch (error) {
            // Graph teardown and orchestrator teardown are intentionally both
            // best-effort. A graph may already have released this same browser
            // through the provider wrapper; that is an idempotent close, not a
            // resource leak or a run failure.
            if (
              !(error instanceof Error) ||
              !error.message.includes('Browser session is not owned by this run')
            ) {
              throw error;
            }
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
        assertSessionProvider(sessions, sessionId, providerId, action.runId);
        const closed = await adapter.closeSession(sessionId, ctx);
        if (!closed.ok) throw new Error(closed.error.message);
        sessions.delete(sessionId);
        return output(action, { closed: sessionId }, 'Closed browser session.');
      }

      const suppliedSessionId = optionalString(args, 'sessionId');
      const stateful = ['inspect', 'click', 'type', 'submit'].includes(operation);
      if (stateful && !suppliedSessionId) {
        throw new Error(operation + ' requires an existing sessionId; open a page first.');
      }
      const requestedUrl = requestedStartUrl(operation, args);
      assertSensitiveDestination(action.dataLabels, requestedUrl);

      const research = operation === 'search' || operation === 'read' || operation === 'extract';
      if (research) {
        if (operation === 'search') requiredString(args, 'query');
        else requiredString(args, 'instruction');
      }
      const publicOnly = action.dataLabels.every((label) => label === 'public');
      if (research && !suppliedSessionId && requestedUrl && publicOnly && adapter.navigate) {
        return pooledResearch(adapter, providerId, action, operation, requestedUrl, ctx);
      }

      let sessionId = suppliedSessionId;
      let ownsSession = false;
      if (sessionId) {
        assertSessionProvider(sessions, sessionId, providerId, action.runId);
        assertSensitiveDestination(action.dataLabels, sessions.get(sessionId)?.url);
      } else {
        const opened = await adapter.openSession(
          requestedUrl ? { startUrl: requestedUrl } : {},
          childContext(ctx, 'browser-session-open'),
        );
        if (!opened.ok) throw new Error('Could not open browser session: ' + opened.error.message);
        sessionId = opened.data.sessionId;
        ownsSession = true;
        sessions.set(sessionId, {
          providerId,
          url: requestedUrl,
          runId: action.runId,
          interactive: opened.data.interactive === true,
        });
      }

      try {
        if (operation === 'open') {
          ownsSession = false;
          return output(
            action,
            {
              sessionId,
              liveViewUrl: null,
              interactive: openedInteractive(sessions, sessionId),
              backend: providerId,
            },
            'Opened a ' + providerId + ' browser session.',
          );
        }

        if (research) {
          return await researchOutput(adapter, sessionId, action, operation, ctx);
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
        sessions.set(sessionId, {
          ...sessions.get(sessionId),
          providerId,
          url: performed.data.url,
          runId: action.runId,
          interactive: sessions.get(sessionId)?.interactive ?? false,
        });

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

/** CSS scope of the result list on the search page requestedStartUrl opens. */
const SEARCH_RESULTS_SCOPE = '#links';
/** Below this, a scoped read is treated as missing and the whole page is read instead. */
const MIN_SCOPED_EVIDENCE_CHARS = 200;

/**
 * Read a research page as bounded evidence. The agent's natural-language
 * `instruction` is validated but NOT forwarded: adapter.extract reads it as a
 * CSS scope, and natural language there threw inside the page ("Uncaught").
 *
 * The focused region is tried first (search results, then <main>), whole page
 * second. Whole-page text on a store spent the evidence budget on site
 * navigation, so prices never reached the agent and it searched product
 * after product looking for them.
 */
async function researchOutput(
  adapter: BrowserAdapter,
  sessionId: string,
  action: ToolAction,
  operation: string,
  ctx: ProviderCallContext,
): Promise<ToolExecutionOutput> {
  const scopes = operation === 'search' ? [SEARCH_RESULTS_SCOPE, ''] : ['main', ''];
  let extracted: Awaited<ReturnType<BrowserAdapter['extract']>> | undefined;
  for (const scope of scopes) {
    extracted = await adapter.extract<Json>(
      { sessionId, instruction: scope },
      childContext(ctx, 'browser-read'),
    );
    if (extracted.ok && evidenceTextLength(extracted.data) >= MIN_SCOPED_EVIDENCE_CHARS) break;
  }
  if (!extracted?.ok) throw new Error(extracted?.error.message ?? 'Browser read failed.');
  const publicOnly = action.dataLabels.every((label) => label === 'public');
  const evidence = publicOnly ? boundedEvidence(extracted.data as Json) : { available: true };
  return output(
    action,
    evidence,
    operation === 'search'
      ? 'Completed stateless browser research search.'
      : operation === 'read'
        ? 'Read a page as bounded stateless research evidence.'
        : 'Extracted bounded evidence from the existing browser page.',
    publicOnly ? evidence : undefined,
  );
}

function evidenceTextLength(value: unknown): number {
  if (typeof value === 'string') return value.trim().length;
  if (value && typeof value === 'object' && 'text' in value) {
    const text = (value as { text?: unknown }).text;
    return typeof text === 'string' ? text.trim().length : 0;
  }
  return 0;
}

function requestedStartUrl(operation: string, args: Record<string, Json>): string | undefined {
  const explicit = optionalString(args, 'url');
  if (explicit) return normalizeBrowserUrl(explicit);
  if (operation === 'read') throw new Error('read requires a URL.');
  if (operation === 'extract' && !optionalString(args, 'sessionId')) {
    throw new Error('extract requires an existing sessionId or an explicit URL.');
  }
  if (operation !== 'search') return undefined;
  const query = requiredString(args, 'query');
  // Google bot-checks automated browsers (measured on Browserbase: an empty
  // results page or 'Verifying your request'). DuckDuckGo's HTML endpoint is
  // server-rendered and answered reliably; its results live in #links.
  return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
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
  runId: string,
): void {
  const known = sessions.get(sessionId);
  if (known && known.runId !== runId) {
    throw new Error('Browser session is unknown or belongs to a different run.');
  }
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

function output(
  action: ToolAction,
  value: Json,
  summary: string,
  modelOutput?: Json,
): ToolExecutionOutput {
  const publicOnly = action.dataLabels.every((label) => label === 'public');
  return {
    output: value,
    summary,
    ...(publicOnly ? { sanitizedSummary: summary } : {}),
    ...(publicOnly && modelOutput !== undefined ? { modelOutput } : {}),
    dataLabels: [...action.dataLabels],
    verified: true,
  };
}

function openedInteractive(sessions: Map<string, BrowserSession>, sessionId: string): boolean {
  // Interactivity is trusted adapter metadata, never inferred from a URL.
  return sessions.get(sessionId)?.interactive ?? false;
}

/** Whitelist short evidence fields; never pass a provider's whole document through. */
function boundedEvidence(value: Json): Json {
  if (typeof value === 'string') return { text: value.slice(0, 2400) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { available: true };
  }
  const source = value as Record<string, Json>;
  const evidence: Record<string, Json> = {};
  for (const key of ['title', 'text', 'snippet', 'summary', 'description']) {
    const field = source[key];
    if (typeof field === 'string' && field.trim()) evidence[key] = field.slice(0, 1800);
  }
  for (const key of ['url', 'sourceUrl']) {
    const field = source[key];
    if (typeof field !== 'string') continue;
    try {
      const url = new URL(field);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        evidence.url = url.toString().slice(0, 500);
        break;
      }
    } catch {
      // Unparseable provider URLs are excluded from the model-visible artifact.
    }
  }
  const results = source.results;
  if (Array.isArray(results)) {
    evidence.results = results.slice(0, 5).map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return {};
      const result = item as Record<string, Json>;
      return Object.fromEntries(
        ['title', 'url', 'snippet', 'description']
          .filter((key) => typeof result[key] === 'string')
          .map((key) => [key, (result[key] as string).slice(0, key === 'url' ? 500 : 800)]),
      ) as Json;
    });
  }
  return Object.keys(evidence).length ? evidence : { available: true };
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
