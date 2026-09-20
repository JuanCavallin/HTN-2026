/**
 * Local browser — LIVE ADAPTER, real Chrome via playwright-core.
 *
 * ============================================================================
 * WHY THIS EXISTS: Browserbase is a remote data recipient. Anything typed into
 * a page there has left the machine — inputs, screenshots and cookies alike.
 * This adapter is the destination policy names when a step carries `local_only`
 * context or `secret` data. It reports `local://chromium`, and that ledger row
 * is the proof.
 *
 * `playwright-core` SHIPS NO BROWSER BINARIES. It is a driver, not a browser.
 * So we launch an INSTALLED Chrome by channel (`LOCALBROWSER_CHANNEL=chrome`)
 * rather than a downloaded one. With no channel configured, config.ts has
 * already downgraded this provider to mock — this file is never reached.
 *
 * THE ELEMENT TABLE (3B-4) IS BUILT HERE, and this is the only place element
 * HANDLES exist. `ElementTable` carries integers and labels; the `Locator`s
 * behind them live in the closure below and never cross a function boundary
 * that leaves this process. Jev says "7"; this file knows what 7 is.
 *
 * THREE CHECKS BEFORE ANY OPERATION, because a snapshot is already stale by the
 * time a decision comes back, and this is exactly where browser agents get
 * flaky:
 *   1. FRESHNESS  — the snapshotId must still be the session's current one.
 *   2. ATTACHED + INTERACTABLE — the element is still in the DOM, visible, enabled.
 *   3. OCCLUSION  — what is actually at the element's centre point is the
 *      element (or a descendant), not a modal or a cookie banner on top of it.
 * All three refuse rather than act. A refusal is a normal outcome: re-snapshot
 * and re-decide.
 *
 * VENDOR TYPES DO NOT ESCAPE THIS FILE — `Browser`, `Page` and `Locator` appear
 * nowhere in our return types. That is the rule that keeps the adapter swappable.
 * ============================================================================
 */

import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import type {
  BrowserAdapter,
  BrowserPerformResult,
  ElementRow,
  ElementTable,
  ProviderCallContext,
  ProviderResult,
  TargetRejection,
} from '@htn/shared';
import { LOCAL_BROWSER_DESTINATION, needsTarget } from '@htn/shared';
import { config, type ProviderConfig } from '../../config.js';

interface Snapshot {
  id: string;
  table: ElementTable;
  /** index -> live handle. THE thing that never leaves this file. */
  handles: Map<number, Locator>;
  /** index -> position in the page's own query order, for the occlusion probe. */
  domIndices: Map<number, number>;
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

interface Handle {
  browser: Browser;
  page: Page;
  snapshot?: Snapshot;
}

/**
 * Interactive roles only. Static text, headings and images are dropped: they
 * are never an action target, and they are most of a page's element count.
 */
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
 * The in-page collector. ONE call returns every row.
 *
 * WHY A STRING IIFE AND NOT AN ARROW FUNCTION: this package's tsconfig has no
 * `dom` lib — it is a server, and adding one would hand every other file in
 * apps/api a fake `document`. A string body runs in the page where those
 * globals are real and is invisible to tsc.
 *
 * WHY AN IIFE SPECIFICALLY: Playwright's string form evaluates the string as an
 * EXPRESSION in page context. A string containing arrow-function SOURCE
 * (`'el => el.tagName'`) therefore evaluates to a function object, which is not
 * serialisable, and comes back as `undefined` — silently, with no error. That
 * cost a real bug here: every role resolved to 'element' and the occlusion
 * probe always returned falsy, i.e. never blocked. An IIFE is an expression
 * that returns data, so it cannot fail that way.
 *
 * WHY ONE CALL: the previous shape made ~8 protocol round trips PER ELEMENT.
 * On a page with 60 controls that is ~480 round trips for one snapshot, which
 * is the opposite of the latency goal.
 */
const COLLECT_ROWS = `(() => {
  const SEL = ${JSON.stringify(
    [
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
    ].join(','),
  )};
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

/** Labels are the main table-size risk, and the table IS the request state. */
const MAX_LABEL_CHARS = 80;

function truncate(text: string, max = MAX_LABEL_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

function meta(op: string, started: number, destination: string | null) {
  return {
    provider: 'localbrowser' as const,
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
  code: 'UPSTREAM' | 'BAD_INPUT' | 'TIMEOUT' = 'UPSTREAM',
): ProviderResult<T> {
  return {
    ok: false,
    error: {
      code,
      message: err instanceof Error ? err.message : String(err),
      retryable: code !== 'BAD_INPUT',
    },
    meta: meta(op, started, LOCAL_BROWSER_DESTINATION),
  };
}

function rejected<T>(op: string, started: number, reason: TargetRejection): ProviderResult<T> {
  return {
    ok: false,
    error: {
      code: 'BAD_INPUT',
      message: reason,
      // A stale snapshot is worth retrying after a re-snapshot; a wrong
      // operation for the element's role is not.
      retryable: reason === 'stale_snapshot' || reason === 'occluded',
    },
    meta: meta(op, started, LOCAL_BROWSER_DESTINATION),
  };
}

export function createLiveLocalBrowser(cfg: ProviderConfig): BrowserAdapter {
  const sessions = new Map<string, Handle>();

  /** Shared by openSession — concurrency is money on one backend and RAM on this one. */
  function atCapacity(): boolean {
    return sessions.size >= config.browser.maxSessions;
  }

  async function buildTable(
    handle: Handle,
    sessionId: string,
    maxElements: number,
  ): Promise<Snapshot> {
    const all = handle.page.locator(INTERACTIVE_SELECTOR);
    const raw = (await handle.page.evaluate<RawRow[], undefined>(COLLECT_ROWS, undefined)) ?? [];

    // A hidden element is not a candidate: it would bloat the table and invite
    // a decision to pick something unclickable.
    const visible = raw.filter((r) => r.visible);

    const rows: ElementRow[] = [];
    const handles = new Map<number, Locator>();
    const domIndices = new Map<number, number>();

    for (const item of visible.slice(0, maxElements)) {
      const resolvedRole = item.role ?? inferRole(item.tag, item.type);
      const editable =
        resolvedRole === 'textbox' ||
        item.tag === 'textarea' ||
        (item.tag === 'input' && !NON_TEXT_INPUT.has(item.type ?? 'text'));
      const selectable = resolvedRole === 'combobox' || item.tag === 'select';

      const index = rows.length + 1;
      rows.push({
        index,
        role: resolvedRole,
        label: truncate(item.name),
        ...(item.value ? { value: truncate(item.value, 40) } : {}),
        clickable: true,
        editable,
        selectable,
      });
      // The handle, keyed by the index the decision will return. `nth` resolves
      // in document order, the same order querySelectorAll produced above.
      handles.set(index, all.nth(item.domIndex));
      domIndices.set(index, item.domIndex);
    }

    const id = 'snap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    return {
      id,
      handles,
      domIndices,
      table: {
        snapshotId: id,
        sessionId,
        url: handle.page.url(),
        title: await handle.page.title().catch(() => ''),
        capturedAt: new Date().toISOString(),
        rows,
        truncated: rows.length < visible.length,
        totalInteractive: visible.length,
      },
    };
  }

  /**
   * Is the element actually the thing a user would hit at that point?
   *
   * `elementFromPoint` at the centre answers the question a visibility flag
   * cannot: a cookie banner with `z-index: 9999` leaves the button below it
   * "visible" and "enabled" while every click lands on the banner.
   */
  async function isOccluded(handle: Handle, domIndex: number): Promise<boolean> {
    try {
      // An IIFE with the index baked in, for the reason spelled out on
      // COLLECT_ROWS: a string containing arrow-function source evaluates to a
      // function object, comes back `undefined`, and would make this check
      // silently answer "not occluded" for every element on every page.
      const result = await handle.page.evaluate<boolean | null, undefined>(
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
        undefined,
      );
      // `null` means the element is gone; a non-boolean means the probe did not
      // run. Neither proves the element is reachable, so both fail closed.
      return typeof result === 'boolean' ? result : true;
    } catch {
      return true;
    }
  }

  return {
    id: 'localbrowser',
    mode: 'live',
    capabilities: ['browser.local'],

    async health() {
      const started = Date.now();
      if (!cfg.channel) {
        return {
          ok: false,
          error: {
            code: 'AUTH',
            message:
              'LOCALBROWSER_CHANNEL is not set. playwright-core ships no browser binaries; ' +
              'set it to an installed channel such as "chrome".',
            retryable: false,
          },
          meta: meta('health', started, null),
        };
      }
      return {
        ok: true,
        data: { detail: 'channel=' + cfg.channel + ', sessions=' + sessions.size },
        meta: meta('health', started, LOCAL_BROWSER_DESTINATION),
      };
    },

    async invoke(op) {
      return failure(
        op,
        Date.now(),
        new Error('No generic invoke() op is defined for localbrowser.'),
        'BAD_INPUT',
      );
    },

    async openSession(input, _ctx: ProviderCallContext) {
      const started = Date.now();
      if (atCapacity()) {
        return failure(
          'openSession',
          started,
          new Error(
            'BROWSER_MAX_SESSIONS=' + config.browser.maxSessions + ' reached for localbrowser',
          ),
          'BAD_INPUT',
        );
      }

      let browser: Browser | undefined;
      try {
        browser = await chromium.launch({
          channel: cfg.channel,
          headless: true,
          timeout: config.browser.timeoutMs,
        });
        const page = await browser.newPage();
        page.setDefaultTimeout(config.browser.timeoutMs);

        if (input.startUrl) {
          await page.goto(input.startUrl, { waitUntil: 'domcontentloaded' });
        }

        const sessionId = 'lb_' + Math.random().toString(36).slice(2, 10);
        sessions.set(sessionId, { browser, page });

        // No live view URL: the browser is on this machine. Reporting a fake
        // one would break the truthful-labeling acceptance criterion.
        return {
          ok: true as const,
          data: { sessionId, liveViewUrl: undefined },
          meta: meta('openSession', started, LOCAL_BROWSER_DESTINATION),
        };
      } catch (err) {
        // A half-launched browser is a leaked Chrome process. Close it here —
        // there is no session id yet, so nothing else can ever close it.
        await browser?.close().catch(() => {});
        return failure('openSession', started, err);
      }
    },

    async act(input, _ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle) {
        return failure('act', started, new Error('Unknown sessionId'), 'BAD_INPUT');
      }
      try {
        // Deliberately NOT natural language: this adapter has no LLM. A plain
        // URL navigates; anything else is the Jev-driven `perform` path's job.
        if (/^https?:\/\//i.test(input.instruction)) {
          await handle.page.goto(input.instruction, { waitUntil: 'domcontentloaded' });
        } else {
          return failure(
            'act',
            started,
            new Error(
              'localbrowser.act takes a URL. For element-level actions use snapshot() + ' +
                'perform(), which is the Jev-driven path.',
            ),
            'BAD_INPUT',
          );
        }
        // Any navigation invalidates the snapshot the caller may hold.
        handle.snapshot = undefined;
        return {
          ok: true as const,
          data: { url: handle.page.url() },
          meta: meta('act', started, LOCAL_BROWSER_DESTINATION),
        };
      } catch (err) {
        return failure('act', started, err);
      }
    },

    async extract<T = unknown>(
      input: { sessionId: string; instruction: string },
      _ctx: ProviderCallContext,
    ) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle) {
        return failure<T>('extract', started, new Error('Unknown sessionId'), 'BAD_INPUT');
      }
      try {
        // Deterministic text extraction, no model. `instruction` is an optional
        // CSS scope; empty means the whole body.
        const scope = input.instruction.trim();
        const text = scope
          ? await handle.page.locator(scope).first().innerText()
          : await handle.page.locator('body').innerText();
        return {
          ok: true as const,
          data: {
            url: handle.page.url(),
            title: await handle.page.title().catch(() => ''),
            text: truncate(text, 4000),
          } as T,
          meta: meta('extract', started, LOCAL_BROWSER_DESTINATION),
        };
      } catch (err) {
        return failure<T>('extract', started, err);
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
          meta: meta('snapshot', started, LOCAL_BROWSER_DESTINATION),
        };
      } catch (err) {
        return failure<ElementTable>('snapshot', started, err);
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
          'BAD_INPUT',
        );
      }

      /* -- Untargeted operations first: no index, no freshness question. ---- */
      if (!needsTarget(input.operation)) {
        try {
          if (input.operation === 'SCROLL_DOWN') {
            await handle.page.mouse.wheel(0, 600);
          } else if (input.operation === 'SCROLL_UP') {
            await handle.page.mouse.wheel(0, -600);
          } else if (input.operation === 'WAIT') {
            await handle.page.waitForTimeout(500);
          }
          // DONE / BLOCKED touch the browser at all — they are the loop's
          // terminal signals, recorded and returned unchanged.
          handle.snapshot = undefined;
          return {
            ok: true as const,
            data: {
              operation: input.operation,
              url: handle.page.url(),
              navigated: false,
            },
            meta: meta('perform', started, LOCAL_BROWSER_DESTINATION),
          };
        } catch (err) {
          return failure<BrowserPerformResult>('perform', started, err);
        }
      }

      /* -- 1. FRESHNESS. ---------------------------------------------------- */
      const snap = handle.snapshot;
      if (!snap || snap.id !== input.snapshotId) {
        return rejected<BrowserPerformResult>('perform', started, 'stale_snapshot');
      }

      if (input.index === undefined) {
        return rejected<BrowserPerformResult>('perform', started, 'wrong_operation');
      }

      const locator = snap.handles.get(input.index);
      const row = snap.table.rows.find((r) => r.index === input.index);
      if (!locator || !row) {
        return rejected<BrowserPerformResult>('perform', started, 'unknown_index');
      }

      // The operation must match what the row actually is. Jev was offered only
      // eligible indices per operation, but the gate does not assume that.
      const eligible =
        input.operation === 'CLICK'
          ? row.clickable
          : input.operation === 'TYPE_TEXT'
            ? row.editable
            : row.selectable;
      if (!eligible) {
        return rejected<BrowserPerformResult>('perform', started, 'wrong_operation');
      }

      try {
        /* -- 2. ATTACHED + INTERACTABLE. ----------------------------------- */
        const count = await locator.count();
        if (count === 0) return rejected<BrowserPerformResult>('perform', started, 'detached');
        if (!(await locator.isVisible()) || !(await locator.isEnabled())) {
          return rejected<BrowserPerformResult>('perform', started, 'not_interactable');
        }

        /* -- 3. OCCLUSION. -------------------------------------------------- */
        const domIndex = snap.domIndices.get(input.index);
        if (domIndex === undefined || (await isOccluded(handle, domIndex))) {
          return rejected<BrowserPerformResult>('perform', started, 'occluded');
        }

        const urlBefore = handle.page.url();

        if (input.operation === 'CLICK') {
          await locator.click({ timeout: config.browser.timeoutMs });
        } else if (input.operation === 'TYPE_TEXT') {
          // Jev picked the FIELD. `text` came from a generative model, never
          // from Jev — Jev cannot produce text at all.
          await locator.fill(input.text ?? '', { timeout: config.browser.timeoutMs });
        } else {
          await locator.selectOption(input.text ?? '', { timeout: config.browser.timeoutMs });
        }

        const url = handle.page.url();
        // Whatever just happened, the table we decided against is now suspect.
        handle.snapshot = undefined;

        return {
          ok: true as const,
          data: {
            operation: input.operation,
            index: input.index,
            url,
            navigated: url !== urlBefore,
          },
          meta: meta('perform', started, LOCAL_BROWSER_DESTINATION),
        };
      } catch (err) {
        return failure<BrowserPerformResult>('perform', started, err);
      }
    },

    async closeSession(sessionId, _ctx) {
      const started = Date.now();
      const handle = sessions.get(sessionId);
      // Idempotent: closing an already-closed session is a success, so a
      // `finally` block can call this unconditionally without swallowing the
      // real error that sent it there.
      if (!handle) {
        return { ok: true as const, data: null, meta: meta('closeSession', started, null) };
      }
      // Delete FIRST. If close() throws we must still free the slot, or a
      // wedged browser permanently consumes BROWSER_MAX_SESSIONS.
      sessions.delete(sessionId);
      try {
        await handle.browser.close();
        return {
          ok: true as const,
          data: null,
          meta: meta('closeSession', started, LOCAL_BROWSER_DESTINATION),
        };
      } catch (err) {
        return failure('closeSession', started, err);
      }
    },
  };
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
