/**
 * Browserbase — cloud browser automation. LIVE ADAPTER via Stagehand v4.
 *
 * ============================================================================
 * PRIVACY NOTE — DO NOT BREAK THIS: this browser runs in Browserbase's cloud.
 * Anything typed into a page here HAS LEFT THE MACHINE — inputs, screenshots
 * and cookies alike. The rule is encoded in the descriptors
 * (core/tools/browserDescriptors.ts): no Browserbase descriptor allows
 * `local_only` context or `secret` data, so a sensitive step never sees this
 * backend as a candidate. If a sensitive value must be TYPED into a form, that
 * is the local Playwright adapter's job, not this one's.
 *
 * VERIFIED AGAINST @browserbasehq/stagehand@4.1.0's own .d.ts (not docs, not
 * memory). Re-check against dist/index.d.mts if the version moves.
 *
 * ---------------------------------------------------------------------------
 * THE `model` OPTION IS OPTIONAL, AND OMITTING IT IS THE WHOLE FIX.
 *
 * This adapter used to pass `model: { apiKey: config...anthropic.apiKey, ... }`
 * unconditionally. With no ANTHROPIC_API_KEY that object is present but empty,
 * which fails the SDK's own `min(1)` validation, so `openSession` died with a
 * raw zod dump and NOTHING worked — verified live, that was this repo's state.
 *
 * Two things had to be true at once:
 *   - Stagehand MUST be attached before `browser.context` is usable at all.
 *     Skipping it raises "Browser context is unavailable". So it cannot be
 *     created lazily.
 *   - `model` is `z.ZodOptional`. Leaving the key OUT entirely is valid.
 *
 * So Stagehand is created eagerly, without a model unless we have one:
 *
 *   openSession / snapshot / perform / closeSession  -> Browserbase creds only
 *   act / extract (natural language)                 -> also need an LLM key
 *
 * The element-level path — the one the Jev design actually depends on —
 * therefore works with the credentials we have. Verified live.
 * ---------------------------------------------------------------------------
 *
 * FACTS ESTABLISHED AGAINST THE LIVE API — do not re-derive:
 *   - Project concurrency limit is 25. BROWSER_MAX_SESSIONS defaults to 2.
 *   - The session replay/recording API is DEPRECATED and returns 404. Do not
 *     plan on it as demo evidence; use the live-view URL plus our own trace.
 *   - The live-view URL returns 410 GONE once the session stops. Capture it
 *     while the session is open — it cannot be fetched afterwards.
 *   - Egress is region-specific (connect.usw2.browserbase.com, not the generic
 *     host), and approvals bind to a destination, so bind to the per-session
 *     value where we can learn it.
 *   - REQUEST_RELEASE works; sessions reach COMPLETED. Release on every exit
 *     path or you burn a slot and money.
 * ============================================================================
 */

import { browserbase, Stagehand, type StagehandBrowser } from '@browserbasehq/stagehand';
import type {
  BrowserAdapter,
  BrowserPerformResult,
  ElementRow,
  ElementTable,
  ProviderCallContext,
  ProviderResult,
  TargetRejection,
} from '@htn/shared';
import { BROWSERBASE_API_DESTINATION, needsTarget } from '@htn/shared';
import { config, type ProviderConfig } from '../../config.js';

/**
 * The live-view URL comes from Browserbase's REST API, called directly.
 *
 * This USED to go through `@browserbasehq/sdk` via a variable specifier, so the
 * file would still compile without it. The catch was that the package is only a
 * transitive dependency under pnpm's strict layout, so the import never
 * resolved, the URL was always `undefined`, and a live session reported no live
 * view at all -- silently, because the whole path was written to degrade
 * quietly. Measured against a real Browserbase run: `interactive: false`, no URL.
 *
 * Two plain `fetch` calls do the same job with NO new dependency, which also
 * keeps this off the "only the dependency owner adds packages" path and out of
 * the hour-30 freeze. If the SDK is ever added for other reasons, this can go
 * back to using it -- the shape returned here is the contract, not the transport.
 */
const BROWSERBASE_API = 'https://api.browserbase.com/v1';

interface Snapshot {
  id: string;
  table: ElementTable;
  domIndices: Map<number, number>;
}

interface Handle {
  browser: StagehandBrowser;
  /** Attached at openSession; has a model only when an LLM key exists. */
  stagehand?: Stagehand;
  /** The real Browserbase session id, for the live-view URL. */
  remoteSessionId?: string;
  /** Region-specific where known; approvals bind to this. */
  destination: string;
  snapshot?: Snapshot;
}

/** One row as the in-page collector returns it. Serialisable, no DOM types. */
interface RawRow {
  domIndex: number;
  tag: string;
  role: string | null;
  type: string | null;
  name: string;
  value: string;
  visible: boolean;
}

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[contenteditable="true"]',
].join(',');

/**
 * Identical in shape to the local adapter's collector, and a string IIFE for
 * the same two reasons: this package has no `dom` lib, and Stagehand's
 * `evaluate` string form evaluates an EXPRESSION — a string holding
 * arrow-function source comes back `undefined`, silently.
 */
const COLLECT_ROWS = `(() => {
  const SEL = ${JSON.stringify(INTERACTIVE_SELECTOR)};
  const out = [];
  document.querySelectorAll(SEL).forEach((el, domIndex) => {
    const style = window.getComputedStyle(el);
    const visible =
      el.getClientRects().length > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity) !== 0;
    out.push({
      domIndex,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      type: el.getAttribute('type'),
      name: (
        el.getAttribute('aria-label') ||
        (el.innerText || '').trim() ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        ''
      ),
      value: (el.value === undefined || el.value === null) ? '' : String(el.value),
      visible,
    });
  });
  return out;
})()`;

/**
 * PRE-FLIGHT VALIDATION IN ONE PROTOCOL CALL — see the local adapter for the
 * full reasoning. Against Browserbase this matters more, not less: every
 * protocol call is a round trip to their cloud, so four checks per click is
 * four network hops. `browser-use/jev-ultrafast` reports cutting median
 * protocol calls from 1,092 to 101 by making reads atomic like this.
 */
function validateTargetScript(domIndex: number): string {
  return `(() => {
     const SEL = ${JSON.stringify(INTERACTIVE_SELECTOR)};
     const el = document.querySelectorAll(SEL)[${domIndex}];
     if (!el) return { exists: false };

     const rect = el.getBoundingClientRect();
     const style = window.getComputedStyle(el);
     const visible =
       rect.width > 0 && rect.height > 0 &&
       style.visibility !== 'hidden' && style.display !== 'none' &&
       Number(style.opacity) !== 0;

     const enabled = !el.disabled && el.getAttribute('aria-disabled') !== 'true';

     let occluded = true;
     if (visible) {
       const hit = document.elementFromPoint(
         rect.left + rect.width / 2,
         rect.top + rect.height / 2,
       );
       occluded = !hit || !(hit === el || el.contains(hit) || hit.contains(el));
     }

     return { exists: true, visible, enabled, occluded };
   })()`;
}

interface TargetState {
  exists: boolean;
  visible?: boolean;
  enabled?: boolean;
  occluded?: boolean;
}

/** Everything unproven is treated as not-actionable. */
function rejectionFor(state: TargetState | null): TargetRejection | null {
  if (!state || typeof state !== 'object') return 'occluded';
  if (!state.exists) return 'detached';
  if (!state.visible || !state.enabled) return 'not_interactable';
  if (state.occluded !== false) return 'occluded';
  return null;
}

const MAX_LABEL_CHARS = 80;

function truncate(text: string, max = MAX_LABEL_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

const NON_TEXT_INPUT = new Set([
  'checkbox',
  'radio',
  'submit',
  'button',
  'reset',
  'file',
  'image',
  'range',
  'color',
]);

function inferRole(tag: string, type: string | null): string {
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    return 'textbox';
  }
  return tag || 'element';
}

function meta(op: string, started: number, destination: string | null) {
  return {
    provider: 'browserbase' as const,
    op,
    mode: 'live' as const,
    latencyMs: Date.now() - started,
    destination,
  };
}

function failure<T>(
  op: string,
  started: number,
  err: unknown,
  destination: string | null = BROWSERBASE_API_DESTINATION,
  code: 'UPSTREAM' | 'BAD_INPUT' | 'AUTH' = 'UPSTREAM',
): ProviderResult<T> {
  return {
    ok: false,
    error: {
      code,
      message: err instanceof Error ? err.message : String(err),
      retryable: code === 'UPSTREAM',
    },
    meta: meta(op, started, destination),
  };
}

function rejected<T>(
  op: string,
  started: number,
  reason: TargetRejection,
  destination: string,
): ProviderResult<T> {
  return {
    ok: false,
    error: {
      code: 'BAD_INPUT',
      message: reason,
      retryable: reason === 'stale_snapshot' || reason === 'occluded',
    },
    meta: meta(op, started, destination),
  };
}

/** One Browserbase REST GET. Returns null rather than throwing -- see liveViewUrl. */
async function bbGet<T>(apiKey: string, path: string): Promise<T | null> {
  try {
    const res = await fetch(BROWSERBASE_API + path, {
      headers: { 'X-BB-API-Key': apiKey },
      // Generous but bounded: this runs inside openSession, and a hung metadata
      // call must not hold up a session the caller is waiting on.
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * The live-view URL and the session's region.
 *
 * BEST EFFORT BY DESIGN: a missing URL costs the UI a live view, while a thrown
 * error would cost the run its session. Every failure path here returns
 * partial data rather than raising -- that is deliberate, not sloppy.
 *
 * `debuggerFullscreenUrl` is the INTERACTIVE debug view: a person can click and
 * type in it. That is what `interactive: true` promises downstream and what
 * makes a `handoff` node possible, so it is the only field allowed to set it.
 *
 * MUST BE CALLED WHILE THE SESSION IS RUNNING. `/debug` returns 410 Gone once a
 * session stops, so there is no second chance at this after the fact.
 */
interface DebugPage {
  id?: string;
  url?: string;
  debuggerFullscreenUrl?: string;
}

interface DebugResponse {
  debuggerFullscreenUrl?: string;
  pages?: DebugPage[];
}

/** Trailing-slash-insensitive, so "https://x.com" matches "https://x.com/". */
function sameUrl(a: string, b: string): boolean {
  const trim = (u: string) => u.replace(/\/+$/, '').toLowerCase();
  return trim(a) === trim(b);
}

/**
 * WHICH TAB the live view should show.
 *
 * The top-level `debuggerFullscreenUrl` points at the session's FIRST page,
 * and that is the wrong one whenever a start URL was given: openSession calls
 * `context.newPage(startUrl)`, which leaves page 0 sitting on about:blank and
 * puts the real page second. Measured on a live session -- page 0
 * `about:blank`, page 1 `https://example.com/` -- so someone following the
 * handoff link landed on a blank tab and had no idea why.
 *
 * Preference order: the page matching the start URL, then the last page that
 * is not blank, then whatever the top level said. The last fallback means this
 * can only improve on the old behaviour, never do worse than it.
 */
function pickPage(debug: DebugResponse, startUrl?: string): string | undefined {
  const pages = (debug.pages ?? []).filter((page) => page.debuggerFullscreenUrl);

  if (startUrl) {
    const exact = pages.find((page) => page.url && sameUrl(page.url, startUrl));
    if (exact) return exact.debuggerFullscreenUrl;
  }

  const real = [...pages].reverse().find((page) => page.url && page.url !== 'about:blank');
  return real?.debuggerFullscreenUrl ?? debug.debuggerFullscreenUrl;
}

async function liveViewUrl(
  apiKey: string,
  sessionId: string,
  startUrl?: string,
): Promise<{ url?: string; region?: string }> {
  const [debug, session] = await Promise.all([
    bbGet<DebugResponse>(apiKey, '/sessions/' + sessionId + '/debug'),
    bbGet<{ region?: string }>(apiKey, '/sessions/' + sessionId),
  ]);

  const url = debug ? pickPage(debug, startUrl) : undefined;

  return {
    ...(url ? { url } : {}),
    ...(session?.region ? { region: session.region } : {}),
  };
}

export function createLiveBrowserbase(cfg: ProviderConfig): BrowserAdapter {
  const sessions = new Map<string, Handle>();

  /**
   * `model` is OPTIONAL on Stagehand.create, and that one fact is what makes
   * the element path usable with Browserbase credentials alone.
   *
   * The original bug was passing `model: { apiKey: config...anthropic.apiKey }`
   * with an empty key: an explicitly-present model object fails the SDK's
   * `min(1)` validation and openSession died with a raw zod dump. OMITTING the
   * key entirely is valid — Stagehand attaches, the browser works, and only
   * act()/extract() later complain about having no model.
   *
   * Verified live against a real Browserbase session with no LLM key set.
   */
  // Return type inferred on purpose: the SDK's `modelName` is a literal union,
  // and annotating it as `string` widens it and stops compiling.
  function modelOptions() {
    const llmKey = config.providers.anthropic.apiKey;
    return llmKey
      ? { model: { apiKey: llmKey, modelName: 'anthropic/claude-sonnet-5' as const } }
      : {};
  }

  /** act()/extract() are the only operations that genuinely need a model. */
  function requireModel(): void {
    if (!config.providers.anthropic.apiKey) {
      throw new Error(
        'Stagehand resolves natural-language act()/extract() with a model, so this needs ' +
          'ANTHROPIC_API_KEY in the root .env. Browserbase credentials alone are enough for ' +
          'openSession/snapshot/perform/closeSession — use the element-level path instead.',
      );
    }
  }

  async function activePage(handle: Handle) {
    const page = await handle.browser.context.activePage();
    return page ?? (await handle.browser.context.newPage());
  }

  async function buildTable(
    handle: Handle,
    sessionId: string,
    maxElements: number,
  ): Promise<Snapshot> {
    const page = await activePage(handle);
    const raw = (await page.evaluate<RawRow[], undefined>(COLLECT_ROWS)) ?? [];
    const visible = raw.filter((r) => r.visible);

    const rows: ElementRow[] = [];
    const domIndices = new Map<number, number>();

    for (const item of visible.slice(0, maxElements)) {
      const role = item.role ?? inferRole(item.tag, item.type);
      const index = rows.length + 1;
      rows.push({
        index,
        role,
        label: truncate(item.name),
        ...(item.value ? { value: truncate(item.value, 40) } : {}),
        clickable: true,
        editable:
          role === 'textbox' ||
          item.tag === 'textarea' ||
          (item.tag === 'input' && !NON_TEXT_INPUT.has(item.type ?? 'text')),
        selectable: role === 'combobox' || item.tag === 'select',
      });
      domIndices.set(index, item.domIndex);
    }

    const id = 'snap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    return {
      id,
      domIndices,
      table: {
        snapshotId: id,
        sessionId,
        url: await page.url(),
        title: await page.title().catch(() => ''),
        capturedAt: new Date().toISOString(),
        rows,
        truncated: rows.length < visible.length,
        totalInteractive: visible.length,
      },
    };
  }

  /** Same probe as the local adapter. Anything but `false` fails closed. */
  async function isOccluded(handle: Handle, domIndex: number): Promise<boolean> {
    try {
      const page = await activePage(handle);
      const result = await page.evaluate<boolean | null, undefined>(
        `(() => {
           const SEL = ${JSON.stringify(INTERACTIVE_SELECTOR)};
           const el = document.querySelectorAll(SEL)[${domIndex}];
           if (!el) return null;
           const rect = el.getBoundingClientRect();
           if (rect.width === 0 || rect.height === 0) return true;
           const x = rect.left + rect.width / 2;
           const y = rect.top + rect.height / 2;
           const hit = document.elementFromPoint(x, y);
           if (!hit) return true;
           return !(hit === el || el.contains(hit) || hit.contains(el));
         })()`,
      );
      return typeof result === 'boolean' ? result : true;
    } catch {
      return true;
    }
  }

  return {
    id: 'browserbase',
    mode: 'live',
    capabilities: ['browser'],

    async health() {
      const started = Date.now();
      if (!cfg.apiKey || !cfg.projectId) {
        return {
          ok: false,
          error: {
            code: 'AUTH',
            message: 'Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID',
            retryable: false,
          },
          meta: meta('health', started, null),
        };
      }
      // Truthful labeling: report the degraded capability rather than looking
      // fully healthy and failing on the first act() call.
      const detail = config.providers.anthropic.apiKey
        ? 'live (element path + natural language)'
        : 'live (element path only — ANTHROPIC_API_KEY unset, so act()/extract() will fail)';
      return {
        ok: true,
        data: { detail },
        meta: meta('health', started, BROWSERBASE_API_DESTINATION),
      };
    },

    async invoke(op) {
      return failure(
        op,
        Date.now(),
        new Error('No generic invoke() op is defined for browserbase.'),
        BROWSERBASE_API_DESTINATION,
        'BAD_INPUT',
      );
    },

    async openSession(input, _ctx: ProviderCallContext) {
      const started = Date.now();

      if (sessions.size >= config.browser.maxSessions) {
        return failure(
          'openSession',
          started,
          new Error(
            'BROWSER_MAX_SESSIONS=' +
              config.browser.maxSessions +
              ' reached. The project concurrency limit is 25; raise the cap only if the ' +
              'demo genuinely needs parallel browsers.',
          ),
          BROWSERBASE_API_DESTINATION,
          'BAD_INPUT',
        );
      }

      if (!cfg.apiKey || !cfg.projectId) {
        return failure(
          'openSession',
          started,
          new Error('BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not configured'),
          null,
          'AUTH',
        );
      }

      let browser: StagehandBrowser | undefined;
      let stagehand: Stagehand | undefined;
      try {
        browser = await browserbase.launch({ apiKey: cfg.apiKey, projectId: cfg.projectId });

        // Stagehand MUST be attached before `browser.context` is usable — the
        // handle alone raises "Browser context is unavailable". So it is
        // created here, but WITHOUT a model unless we have a key. See
        // modelOptions().
        stagehand = await Stagehand.create({ browser, ...modelOptions() });

        if (input.startUrl) {
          await browser.context.newPage(input.startUrl);
        }

        const remoteSessionId = browser.sessionId;
        // Capture the live-view URL NOW. sessions.debug() returns 410 Gone once
        // the session stops, so there is no second chance at this.
        const view = remoteSessionId
          ? await liveViewUrl(cfg.apiKey, remoteSessionId, input.startUrl)
          : {};

        const destination = view.region
          ? 'https://connect.' + view.region + '.browserbase.com'
          : BROWSERBASE_API_DESTINATION;

        // Our own id, so this adapter's sessionId format stays opaque to
        // callers, consistent with every other provider here.
        const sessionId = 'bb_' + Math.random().toString(36).slice(2, 10);
        sessions.set(sessionId, {
          browser,
          stagehand,
          destination,
          ...(remoteSessionId ? { remoteSessionId } : {}),
        });

        return {
          ok: true as const,
          data: {
            sessionId,
            // `debuggerFullscreenUrl` is Browserbase's INTERACTIVE debug view,
            // not a recording: a person can genuinely click and type in it.
            // That is what makes a `handoff` node possible, so the flag is
            // tied to having that exact URL and nothing else.
            ...(view.url ? { liveViewUrl: view.url, interactive: true } : {}),
          },
          meta: meta('openSession', started, destination),
        };
      } catch (err) {
        // A half-launched browser is a RUNNING Browserbase session nobody holds
        // an id for. Release it here or it burns a slot until it times out.
        await browser?.close().catch(() => {});
        return failure('openSession', started, err);
      }
    },

    async act(input, _ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle) {
        return failure('act', started, new Error('Unknown sessionId'), null, 'BAD_INPUT');
      }
      try {
        requireModel();
        if (!handle.stagehand) throw new Error('Stagehand is not attached to this session.');
        await handle.stagehand.act(input.instruction);
        handle.snapshot = undefined;
        const page = await handle.browser.context.activePage();
        return {
          ok: true as const,
          data: { url: (await page?.url()) ?? '' },
          meta: meta('act', started, handle.destination),
        };
      } catch (err) {
        return failure('act', started, err, handle.destination);
      }
    },

    async extract<T = unknown>(
      input: { sessionId: string; instruction: string },
      _ctx: ProviderCallContext,
    ) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle) {
        return failure<T>('extract', started, new Error('Unknown sessionId'), null, 'BAD_INPUT');
      }
      try {
        const page = await activePage(handle);

        // DETERMINISTIC PATH, and the default. Reading a page's text needs no
        // model, and requiring one here made this backend unusable without an
        // LLM key while the local adapter worked fine — the two must behave the
        // same or "local is equivalent for ordinary pages" is not a real claim.
        //
        // `instruction` is an optional CSS scope, matching localbrowser.extract.
        // Natural-language extraction is opt-in via `nl:` below.
        if (!input.instruction.startsWith('nl:')) {
          const scope = input.instruction.trim();
          const text = await page.evaluate<string, undefined>(
            scope
              ? `(() => { const el = document.querySelector(${JSON.stringify(scope)});
                   return el ? (el.innerText || '') : ''; })()`
              : `(() => (document.body && document.body.innerText) || '')()`,
          );
          return {
            ok: true as const,
            data: {
              url: await page.url(),
              title: await page.title().catch(() => ''),
              text: truncate(text ?? '', 4000),
            } as T,
            meta: meta('extract', started, handle.destination),
          };
        }

        // NATURAL-LANGUAGE PATH: only this one needs a model.
        requireModel();
        if (!handle.stagehand) throw new Error('Stagehand is not attached to this session.');
        // No zod schema -> Stagehand returns { extraction: string }. Pass a
        // schema as a second argument for structured extraction.
        const result = await handle.stagehand.extract(input.instruction.slice(3).trim());
        return {
          ok: true as const,
          data: result.data as T,
          meta: meta('extract', started, handle.destination),
        };
      } catch (err) {
        return failure<T>('extract', started, err, handle.destination);
      }
    },

    async snapshot(input, _ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle) {
        return failure<ElementTable>(
          'snapshot',
          started,
          new Error('Unknown sessionId'),
          null,
          'BAD_INPUT',
        );
      }
      try {
        const snap = await buildTable(
          handle,
          input.sessionId,
          input.maxElements ?? config.browser.maxElements,
        );
        handle.snapshot = snap;
        return {
          ok: true as const,
          data: snap.table,
          meta: meta('snapshot', started, handle.destination),
        };
      } catch (err) {
        return failure<ElementTable>('snapshot', started, err, handle.destination);
      }
    },

    async perform(input, _ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle) {
        return failure<BrowserPerformResult>(
          'perform',
          started,
          new Error('Unknown sessionId'),
          null,
          'BAD_INPUT',
        );
      }

      try {
        const page = await activePage(handle);

        if (!needsTarget(input.operation)) {
          if (input.operation === 'SCROLL_DOWN') await page.scroll(0, 0, 0, 600);
          else if (input.operation === 'SCROLL_UP') await page.scroll(0, 0, 0, -600);
          else if (input.operation === 'WAIT') await page.waitForTimeout(500);
          handle.snapshot = undefined;
          return {
            ok: true as const,
            data: { operation: input.operation, url: await page.url(), navigated: false },
            meta: meta('perform', started, handle.destination),
          };
        }

        /* -- 1. FRESHNESS. -------------------------------------------------- */
        const snap = handle.snapshot;
        if (!snap || snap.id !== input.snapshotId) {
          return rejected<BrowserPerformResult>(
            'perform',
            started,
            'stale_snapshot',
            handle.destination,
          );
        }
        if (input.index === undefined) {
          return rejected<BrowserPerformResult>(
            'perform',
            started,
            'wrong_operation',
            handle.destination,
          );
        }

        const row = snap.table.rows.find((r) => r.index === input.index);
        const domIndex = snap.domIndices.get(input.index);
        if (!row || domIndex === undefined) {
          return rejected<BrowserPerformResult>(
            'perform',
            started,
            'unknown_index',
            handle.destination,
          );
        }

        const eligible =
          input.operation === 'CLICK'
            ? row.clickable
            : input.operation === 'TYPE_TEXT'
              ? row.editable
              : row.selectable;
        if (!eligible) {
          return rejected<BrowserPerformResult>(
            'perform',
            started,
            'wrong_operation',
            handle.destination,
          );
        }

        const locator = page.locator(INTERACTIVE_SELECTOR).nth(domIndex);

        /* -- 2 AND 3, IN ONE ROUND TRIP: attached, interactable, occluded. -- */
        // Each of these used to be a separate call, and against a CLOUD browser
        // every call is a network hop. Collapsing them is the single cheapest
        // latency win available here.
        const state = await page
          .evaluate<TargetState | null, undefined>(validateTargetScript(domIndex))
          .catch(() => null);

        const rejection = rejectionFor(state);
        if (rejection) {
          return rejected<BrowserPerformResult>('perform', started, rejection, handle.destination);
        }

        const urlBefore = await page.url();

        if (input.operation === 'CLICK') {
          await locator.click();
        } else if (input.operation === 'TYPE_TEXT') {
          // The decision picked the FIELD. The value came from a generative
          // model or from the caller's args — never from Jev.
          await locator.fill(input.text ?? '');
        } else {
          await locator.selectOption([input.text ?? '']);
        }

        // Let the page settle before anyone snapshots it again. A combobox
        // needs longer than a click because its suggestions render async;
        // these are jev-ultrafast's numbers (~200ms / ~50ms), not a guess.
        await page.waitForTimeout(
          input.operation === 'SELECT' ? config.browser.settleSelectMs : config.browser.settleMs,
        );

        const url = await page.url();
        handle.snapshot = undefined;

        return {
          ok: true as const,
          data: {
            operation: input.operation,
            index: input.index,
            url,
            navigated: url !== urlBefore,
          },
          meta: meta('perform', started, handle.destination),
        };
      } catch (err) {
        return failure<BrowserPerformResult>('perform', started, err, handle.destination);
      }
    },

    async closeSession(sessionId, _ctx) {
      const started = Date.now();
      const handle = sessions.get(sessionId);
      // Idempotent, so a `finally` can call this unconditionally without
      // masking the error that sent it there.
      if (!handle) {
        return { ok: true as const, data: null, meta: meta('closeSession', started, null) };
      }
      // Delete FIRST: if close() throws we must still free the slot, or a
      // wedged session permanently consumes BROWSER_MAX_SESSIONS.
      sessions.delete(sessionId);
      try {
        await handle.browser.close();
        return {
          ok: true as const,
          data: null,
          meta: meta('closeSession', started, handle.destination),
        };
      } catch (err) {
        return failure('closeSession', started, err, handle.destination);
      }
    },
  };
}
