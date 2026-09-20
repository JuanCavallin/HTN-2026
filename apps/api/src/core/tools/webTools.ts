/**
 * The `web` tool family: live-web lookups through OUR gated browser.
 *
 * ============================================================================
 * WHY THIS IS A TOOL AND NOT A HERMES TASK. Hermes on this install has no
 * working browser (see the header of providers/hermes/live.ts): asked to look
 * something up it approximates with `web_search`, spends minutes, and none of
 * it passes through our authorize gate or our egress ledger. These two tools
 * do the same job as ONE deterministic step -- open a page in a cloud browser,
 * read it, release the session -- and every byte of it is gated, ledgered and
 * attributed to the run and node that asked.
 *
 * They are thin on purpose. `browserbase.extract` (core/tools/browser.ts)
 * already opens a session when none is passed, reads the page, and releases it
 * in a `finally`. All this file adds is:
 *
 *   web.search  query -> a search URL   -> extract
 *   web.read    url   -> (validated)    -> extract
 *
 * and a stable, model-friendly result shape. No Jev call is needed: there is no
 * element to choose, because the URL already carries the query. Jev is for
 * `click`/`type` on a page you are already on.
 *
 * EXECUTOR DELEGATION, NOT DOUBLE-GATING. This executor does NOT call
 * `authorize_action` itself. It rewrites the request into the concrete browser
 * action (`browserbase.extract` on a real URL) and hands THAT to the browser
 * executor, which gates it. So the gate sees -- and an approval would show --
 * the exact URL that will be fetched, not an abstract "web.search".
 *
 * PAGE TEXT IS UNTRUSTED. It is returned as DATA. Nothing here interprets it,
 * and a page saying "ignore your instructions" changes no permission: the
 * gate acts on the action, never on what a page claims.
 * ============================================================================
 */

import type { Json, ToolAction, ToolDescriptor, ToolExecutor, ToolResult } from '@htn/shared';

export const WEB_FAMILY = 'web';
export const WEB_EXECUTOR_REF = 'executor:web';

/** What `web.*` calls DO, in core/risk.ts's vocabulary: they only read. */
export const WEB_ACTION_KIND = 'read_page';

const VERSION = '1.0.0';

export interface WebDescriptorOptions {
  /** False when there is no browser backend to serve them. */
  available?: boolean;
}

export function webDescriptors(options: WebDescriptorOptions = {}): ToolDescriptor[] {
  const availability: ToolDescriptor['availability'] =
    options.available === false ? 'unauthenticated' : 'available';

  // Mirrors the Browserbase descriptors: a query or URL leaves the machine, so
  // NO `secret` data and NO `local_only` context -- those never see this family.
  const shared = {
    providerId: 'browserbase',
    family: WEB_FAMILY,
    transport: 'native' as const,
    riskClass: 'auto' as const,
    requiredScopes: [] as string[],
    allowedDataLabels: ['public', 'private'] as ToolDescriptor['allowedDataLabels'],
    allowedContextScopes: ['public', 'private'] as ToolDescriptor['allowedContextScopes'],
    availability,
    executorRef: WEB_EXECUTOR_REF,
    version: VERSION,
    simulated: false,
    credentialRef: 'BROWSERBASE_API_KEY',
  };

  return [
    {
      ...shared,
      id: 'web.search',
      description:
        'Search the live web and return the results page text. ' +
        'Args: query (string). Returns: url, title, text -- read the text as {{<node id>.result.text}}.',
      schemaRef: 'schema:web.search@1',
    },
    {
      ...shared,
      id: 'web.read',
      description:
        'Open one public web page and return its text. ' +
        'Args: url (string, http or https). Returns: url, title, text -- read the text as {{<node id>.result.text}}.',
      schemaRef: 'schema:web.read@1',
    },
  ];
}

/**
 * CSS scope for the default engine's results. The whole page's first 4000
 * characters (all the adapter returns) open with ~900 characters of region
 * dropdown; scoping to the results container spends that budget on results.
 * It belongs to the ENGINE, so a caller who swaps `searchUrl` gets no scope
 * unless it supplies one.
 */
const DEFAULT_SEARCH_SCOPE = '#links';

function defaultSearchUrl(query: string): string {
  // html.duckduckgo.com does not challenge a cloud browser the way Google does
  // (see scripts/browser.search.ts for the measurements behind that choice).
  return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
}

/**
 * Only public http(s) pages. `web.read`'s URL can come from a model or from a
 * page it just read, so it is an input to distrust: a local backend would
 * happily fetch an internal address.
 */
function publicHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return null;
  if (/^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host))
    return null;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
  if (host === '::1' || host === '[::1]') return null;
  return url;
}

function bad(action: ToolAction, started: number, message: string): ToolResult {
  return {
    actionId: action.actionId,
    ok: false,
    error: { code: 'BAD_INPUT', message, reason: 'bad-web-tool-args' },
    destination: action.destination,
    latencyMs: Date.now() - started,
  };
}

/** Adapters disagree on shape (live: {url,title,text}; mock: {note}). Flatten. */
function pageOf(output: Json | undefined): { url: string | null; title: string; text: string } {
  const o = output && typeof output === 'object' && !Array.isArray(output) ? output : {};
  let text = JSON.stringify(o);
  if (typeof o.text === 'string') text = o.text;
  else if (typeof o.note === 'string') text = o.note;
  return {
    url: typeof o.url === 'string' ? o.url : null,
    title: typeof o.title === 'string' ? o.title : '',
    text,
  };
}

export interface WebExecutorDeps {
  /** The browser executor. It runs the gate; this file never does. */
  browser: ToolExecutor;
  /** Swap the search engine without touching the tool contract. */
  searchUrl?: (query: string) => string;
  /** CSS scope for THAT engine's results. Defaults to the default engine's own. */
  searchScope?: string;
}

export function createWebExecutor(deps: WebExecutorDeps): ToolExecutor {
  const searchUrl = deps.searchUrl ?? defaultSearchUrl;
  const searchScope = deps.searchScope ?? (deps.searchUrl ? '' : DEFAULT_SEARCH_SCOPE);

  return {
    ref: WEB_EXECUTOR_REF,

    async execute(action: ToolAction, signal?: AbortSignal): Promise<ToolResult> {
      const started = Date.now();
      const operation = action.toolId.split('.').slice(1).join('.');

      let target: URL | null;
      let query: string | undefined;

      if (operation === 'search') {
        query = typeof action.args.query === 'string' ? action.args.query.trim() : '';
        if (!query) return bad(action, started, 'web.search needs a non-empty "query".');
        target = publicHttpUrl(searchUrl(query));
      } else if (operation === 'read') {
        target = publicHttpUrl(typeof action.args.url === 'string' ? action.args.url.trim() : '');
        if (!target) return bad(action, started, 'web.read needs a public http(s) "url".');
      } else {
        return bad(action, started, 'Unknown web operation: ' + action.toolId);
      }
      if (!target) return bad(action, started, 'Could not build a public URL for this request.');

      // The CONCRETE action. `destination` is where it will really go, which is
      // what the gate's local-only rule and any approval panel need to see.
      const extract = (instruction: string): Promise<ToolResult> =>
        deps.browser.execute(
          {
            ...action,
            toolId: 'browserbase.extract',
            args: { url: target.toString(), instruction },
            destination: target.origin,
          },
          signal,
        );

      // Only a search is scoped. If the scope matches nothing (the engine
      // changed its markup) read the whole page rather than return nothing: a
      // noisy answer beats an empty one, and it costs one more session only in
      // that case.
      const scope = operation === 'search' ? searchScope : '';
      let result = await extract(scope);
      if (scope && result.ok && !pageOf(result.output).text.trim()) result = await extract('');

      if (!result.ok) {
        return { ...result, actionId: action.actionId, latencyMs: Date.now() - started };
      }

      const page = pageOf(result.output);
      return {
        actionId: action.actionId,
        ok: true,
        output: {
          ...(query !== undefined ? { query } : {}),
          url: page.url ?? target.toString(),
          title: page.title,
          text: page.text,
        },
        destination: result.destination,
        latencyMs: Date.now() - started,
      };
    },
  };
}
