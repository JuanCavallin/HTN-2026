/**
 * Browser benchmark: the local-browser adapter against live pages.
 *
 * Per page it measures:
 *   - payload    raw DOM HTML vs a full ARIA snapshot vs the exact request the
 *                Jev browser decider sends. All three are dumped, so tokens can
 *                be counted afterwards (bench-browser-tokens.py).
 *   - snapshot   the adapter's one in-page collector vs reading each element
 *                with separate Playwright calls (~8 per element), the shape the
 *                collector replaced.
 *   - pre-action the adapter's one atomic target check vs the 4-call shape it
 *                replaced (count, isVisible, isEnabled, elementFromPoint).
 *
 *   pnpm bench:browser [outDir]        # default .data/bench-browser (gitignored)
 *   BENCH_PAGES=https://a.example/,https://b.example/ pnpm bench:browser
 *   python apps/api/scripts/bench-browser-tokens.py .data/bench-browser
 *
 * Needs an installed Chrome (LOCALBROWSER_CHANNEL, default "chrome"). Not part
 * of CI: it loads public websites, and its timings depend on the machine.
 * Method and published results: docs/metrics.md.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { ElementTable, ProviderCallContext } from '@htn/shared';
import { config } from '../src/config.js';
import { eligibleRows, renderTable, toCriteria, toState } from '../src/core/tools/elementTable.js';
import { createLiveLocalBrowser } from '../src/providers/localbrowser/live.js';

const OUT =
  process.argv[2] ?? fileURLToPath(new URL('../../../.data/bench-browser', import.meta.url));
const DUMPS = join(OUT, 'dumps');
mkdirSync(DUMPS, { recursive: true });

const PAGES = process.env.BENCH_PAGES?.split(',').filter(Boolean) ?? [
  'https://en.wikipedia.org/wiki/Large_language_model',
  'https://github.com/microsoft/playwright',
  'https://news.ycombinator.com/',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
  'https://www.bbc.com/news',
  'https://www.python.org/',
  'https://www.amazon.com/s?k=laptop',
  'https://www.apple.com/',
  'https://www.microsoft.com/en-us/',
  'https://www.theverge.com/',
  'https://www.cnn.com/',
  'https://www.ycombinator.com/companies',
  'https://www.espn.com/',
  'https://docs.python.org/3/library/asyncio.html',
  'https://www.reddit.com/r/programming/',
];
const SNAPSHOT_RUNS = 5;
const PER_ELEMENT_RUNS = 3;
const CHECK_TARGETS = 20;
const CHECK_ROUNDS = 3;
/** A page that served a bot wall is reported but left out of the medians. */
const BOT_WALL = /sorry|prove your humanity|just a moment|access denied|attention required/i;

// Same list as INTERACTIVE_SELECTOR in providers/localbrowser/live.ts.
const SELECTOR = [
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

interface Row {
  url: string;
  title: string;
  /** Dump file stem under dumps/. */
  dump: string;
  blocked: boolean;
  interactiveElements: number;
  tableRows: number;
  domChars: number;
  ariaChars: number;
  tableChars: number;
  requestChars: number;
  snapshotBeforeMs: number;
  snapshotAfterMs: number;
  perElementCalls: number;
  checkBeforeMs: number;
  checkAfterMs: number;
}

// The adapter launches its own Chrome and never hands out the Page. Wrapping
// launch() on the shared module instance lets every measurement below run
// against exactly the page the adapter snapshots.
let launched: Browser | undefined;
const launch = chromium.launch.bind(chromium);
chromium.launch = async (options) => {
  launched = await launch(options);
  return launched;
};

const ctx: ProviderCallContext = { runId: 'bench', stepId: 'bench', policyRule: 'bench-browser' };
const adapter = createLiveLocalBrowser({
  mode: 'live',
  channel: process.env.LOCALBROWSER_CHANNEL ?? 'chrome',
  keyVar: 'LOCALBROWSER_CHANNEL',
});
const snapshot = adapter.snapshot?.bind(adapter);
if (!snapshot) throw new Error('The local-browser adapter has no snapshot().');

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The shape the in-page collector replaced: about 8 Playwright calls per element. */
async function perElementSnapshot(page: Page): Promise<number> {
  const all = page.locator(SELECTOR);
  const count = await all.count();
  let calls = 1;
  let rows = 0;
  for (let i = 0; i < count && rows < config.browser.maxElements; i += 1) {
    const element = all.nth(i);
    calls += 1;
    if (!(await element.isVisible().catch(() => false))) continue;
    await element.evaluate((node: { tagName: string }) => node.tagName).catch(() => '');
    await element.getAttribute('role').catch(() => null);
    await element.getAttribute('type').catch(() => null);
    await element.getAttribute('aria-label').catch(() => null);
    await element.innerText({ timeout: 2_000 }).catch(() => '');
    await element.getAttribute('placeholder').catch(() => null);
    await element.getAttribute('title').catch(() => null);
    calls += 7;
    rows += 1;
  }
  return calls;
}

// String IIFEs, as in the adapter: this package has no DOM lib.
const visibleIndices = `(() => {
  const out = [];
  document.querySelectorAll(${JSON.stringify(SELECTOR)}).forEach((el, i) => {
    const s = window.getComputedStyle(el);
    if (el.getClientRects().length > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0) out.push(i);
  });
  return out;
})()`;

/** The 4th call of the old 4-call check. */
const occlusionProbe = (index: number): string => `(() => {
  const el = document.querySelectorAll(${JSON.stringify(SELECTOR)})[${index}];
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return true;
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (!hit) return true;
  return !(hit === el || el.contains(hit) || hit.contains(el));
})()`;

/** Same body as validateTargetScript() in providers/localbrowser/live.ts. */
const atomicCheck = (index: number): string => `(() => {
  const el = document.querySelectorAll(${JSON.stringify(SELECTOR)})[${index}];
  if (!el) return { exists: false };
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  const visible = rect.width > 0 && rect.height > 0 &&
    style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  const enabled = !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  let occluded = true;
  if (visible) {
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    occluded = !hit || !(hit === el || el.contains(hit) || hit.contains(el));
  }
  return { exists: true, visible, enabled, occluded };
})()`;

/** The request providers/jev/browserDecider.ts builds for a step with every operation allowed. */
function jevRequest(table: ElementTable, goal: string) {
  const click = toCriteria(eligibleRows(table, 'CLICK'));
  const type = toCriteria(eligibleRows(table, 'TYPE_TEXT'));
  const select = toCriteria(eligibleRows(table, 'SELECT'));
  const operation: Record<string, string> = {};
  if (click) operation.CLICK = 'Click one of the listed elements.';
  if (type) {
    operation.TYPE_TEXT = 'Type into one of the listed fields. A separate model supplies the text.';
  }
  if (select) operation.SELECT = 'Choose an option in a dropdown.';
  Object.assign(operation, {
    SCROLL_DOWN: 'Scroll down to reveal more.',
    SCROLL_UP: 'Scroll back up.',
    WAIT: 'Wait for the page to settle.',
    DONE: 'The goal is already satisfied on this page.',
    BLOCKED: 'The goal cannot be progressed from this page.',
  });
  const questions: Record<string, unknown> = {
    operation: {
      type: 'choice',
      instructions: 'What is the single best next action for the goal?',
      criteria: operation,
    },
  };
  if (click && Object.keys(click).length > 1) {
    questions.click_target = {
      type: 'choice',
      instructions: 'Which element should be clicked?',
      criteria: click,
    };
  }
  if (type && Object.keys(type).length > 1) {
    questions.type_text_target = {
      type: 'choice',
      instructions: 'Which field should be typed into?',
      criteria: type,
    };
  }
  if (select && Object.keys(select).length > 1) {
    questions.select_target = {
      type: 'choice',
      instructions: 'Which dropdown should be used?',
      criteria: select,
    };
  }
  return { state: toState(table, goal), questions };
}

const rows: Row[] = [];
let chrome = 'unknown';

for (const url of PAGES) {
  const opened = await adapter.openSession({ startUrl: url }, ctx);
  if (!opened.ok) {
    console.error('SKIP ' + url + ': ' + opened.error.message);
    continue;
  }
  const { sessionId } = opened.data;
  try {
    if (!launched) throw new Error('Did not capture the adapter browser.');
    chrome = launched.version();
    const page = launched.contexts()[0].pages()[0];
    await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);

    const title = await page.title();
    const dom = await page.evaluate<string, undefined>(
      'document.documentElement.outerHTML',
      undefined,
    );
    const aria = await page
      .locator('body')
      .ariaSnapshot({ timeout: 15_000 })
      .catch(() => '');

    // Current path: the adapter's own snapshot().
    const afterMs: number[] = [];
    let table: ElementTable | undefined;
    for (let run = 0; run < SNAPSHOT_RUNS; run += 1) {
      const started = performance.now();
      const result = await snapshot({ sessionId }, ctx);
      afterMs.push(performance.now() - started);
      if (!result.ok) throw new Error(result.error.message);
      table = result.data;
    }
    if (!table) throw new Error('No snapshot was taken.');

    const request = JSON.stringify(jevRequest(table, 'Open the most relevant result for the goal'));
    const dump = new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '_');
    writeFileSync(join(DUMPS, dump + '.dom.html'), dom, 'utf8');
    writeFileSync(join(DUMPS, dump + '.aria.txt'), aria, 'utf8');
    writeFileSync(join(DUMPS, dump + '.request.json'), request, 'utf8');

    // Previous path: per-element reads, same element cap.
    const beforeMs: number[] = [];
    let perElementCalls = 0;
    for (let run = 0; run < PER_ELEMENT_RUNS; run += 1) {
      const started = performance.now();
      perElementCalls = await perElementSnapshot(page);
      beforeMs.push(performance.now() - started);
    }

    // Pre-action check per target: 4 calls vs 1 atomic evaluate.
    const targets = (await page.evaluate<number[], undefined>(visibleIndices, undefined)).slice(
      0,
      CHECK_TARGETS,
    );
    const all = page.locator(SELECTOR);
    const checkBefore: number[] = [];
    const checkAfter: number[] = [];
    for (let round = 0; round < CHECK_ROUNDS; round += 1) {
      for (const index of targets) {
        let started = performance.now();
        const target = all.nth(index);
        await target.count();
        await target.isVisible().catch(() => false);
        await target.isEnabled().catch(() => false);
        await page.evaluate<boolean | null, undefined>(occlusionProbe(index), undefined);
        checkBefore.push(performance.now() - started);
        started = performance.now();
        await page.evaluate<unknown, undefined>(atomicCheck(index), undefined);
        checkAfter.push(performance.now() - started);
      }
    }

    const row: Row = {
      url,
      title: title.slice(0, 60),
      dump,
      blocked: BOT_WALL.test(title) || table.totalInteractive < 10,
      interactiveElements: table.totalInteractive,
      tableRows: table.rows.length,
      domChars: dom.length,
      ariaChars: aria.length,
      tableChars: renderTable(table).length,
      requestChars: request.length,
      snapshotBeforeMs: Math.round(median(beforeMs)),
      snapshotAfterMs: Math.round(median(afterMs)),
      perElementCalls,
      checkBeforeMs: +median(checkBefore).toFixed(2),
      checkAfterMs: +median(checkAfter).toFixed(2),
    };
    rows.push(row);
    console.error((row.blocked ? 'BOT WALL ' : 'OK ') + url);
  } catch (error) {
    console.error('FAIL ' + url + ': ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    await adapter.closeSession(sessionId, ctx);
  }
}

const meta = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  chrome,
  os: process.platform + ' ' + release(),
};
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ meta, rows }, null, 2) + '\n', 'utf8');

const kept = rows.filter((row) => !row.blocked);
const pct = (value: number) => (value * 100).toFixed(1) + '%';
if (kept.length > 0) {
  console.log(`pages measured: ${kept.length} (${rows.length - kept.length} bot walls left out)`);
  console.log(
    'request vs raw DOM, characters: median ' +
      pct(median(kept.map((r) => 1 - r.requestChars / r.domChars))) +
      ' smaller',
  );
  console.log(
    `snapshot: ${median(kept.map((r) => r.snapshotBeforeMs))} ms -> ` +
      `${median(kept.map((r) => r.snapshotAfterMs))} ms (medians), median speedup ` +
      `${Math.round(median(kept.map((r) => r.snapshotBeforeMs / r.snapshotAfterMs)))}x`,
  );
  console.log(
    `pre-action check: ${median(kept.map((r) => r.checkBeforeMs)).toFixed(1)} ms -> ` +
      `${median(kept.map((r) => r.checkAfterMs)).toFixed(2)} ms (medians)`,
  );
}
console.log(`wrote ${join(OUT, 'results.json')}; token counts: bench-browser-tokens.py ${OUT}`);
