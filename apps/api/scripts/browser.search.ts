/**
 * END-TO-END WEB SEARCH — the Person 3 slice on its own, answering a real
 * question from the live web, on either backend.
 *
 *   pnpm --filter @htn/api search -- --q "who won the 2022 world cup"
 *   pnpm --filter @htn/api search -- --mode browserbase --q "..."
 *
 * WHAT THIS PROVES, and what it deliberately does not:
 *
 *   It proves the 3B loop works unaided: open a page, turn it into an indexed
 *   element table, let the DECIDER pick an operation and a target by index,
 *   perform it against the real DOM, re-snapshot, and read an answer out. No
 *   Person 1 runtime, no Person 2 policy — just the browser slice.
 *
 *   It does NOT prove Jev works. The decider is Jev when AI_GATEWAY_API_KEY is
 *   set and JEV_MODE=live, and the deterministic string-matcher otherwise. The
 *   script prints which one decided every single step, because a fallback
 *   presented as a model decision is exactly the dishonesty the design spec's
 *   truthful-labeling rule exists to prevent.
 *
 * WHY DUCKDUCKGO: Google actively challenges automated browsers, and local
 * Chrome browses from your own IP with your own fingerprint, so it gets
 * challenged more than Browserbase does. Using a search engine that does not
 * fight back keeps this a test of OUR code rather than of bot detection. If you
 * want to see that difference, point --url at Google and compare the backends.
 *
 * Jev picks the FIELD and the BUTTON. The query text comes from --q, i.e. from
 * the caller. Jev cannot write text, so it never produces the query.
 */

import type { BrowserAdapter, ElementTable, ProviderCallContext } from '@htn/shared';
import { config } from '../src/config.js';
import { create as createLocalBrowser } from '../src/providers/localbrowser/index.js';
import { create as createBrowserbase } from '../src/providers/browserbase/index.js';
import { createJevBrowserDecider } from '../src/providers/jev/browserDecider.js';
import {
  createComposeText,
  createDeterministicDecider,
  createResolutionCache,
  renderTable,
  withFallback,
  withResolutionCache,
  type BrowserDecider,
  type ComposeText,
} from '../src/core/tools/index.js';
import { create as createAnthropic } from '../src/providers/anthropic/index.js';

function arg(name: string, fallback?: string): string | undefined {
  const withEquals = process.argv.find((a) => a.startsWith('--' + name + '='));
  if (withEquals) return withEquals.split('=').slice(1).join('=');
  const i = process.argv.indexOf('--' + name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

// Browserbase by default. The local backend still works and is still verified
// by `check:browser:live`, but DuckDuckGo CAPTCHAs a home IP and waves the
// cloud through, so web research belongs on Browserbase. Pass `--mode local`
// to use this machine instead.
const MODE = (arg('mode', 'browserbase') ?? 'browserbase') as 'local' | 'browserbase';
const QUESTION = arg('q', 'what is the capital of Portugal') ?? '';
/**
 * DuckDuckGo's NO-JAVASCRIPT endpoint, and that matters.
 *
 * duckduckgo.com renders its results client-side, so `body.innerText` right
 * after navigation returns the nav bar and the footer — the page is there, the
 * results are not yet. This endpoint is server-rendered: the results exist in
 * the first response, and they are plain <a> links, so they show up in the
 * element table too. It also has a real <input> and a real submit button, so
 * the interaction being tested is still a genuine form fill and click.
 */
const START_URL = arg('url', 'https://html.duckduckgo.com/html/') ?? '';

/**
 * Optional CSS scope for the final read, e.g. `--scope "#links"` on DuckDuckGo
 * or `--scope ".mw-parser-output"` on Wikipedia.
 *
 * Without it we read `body.innerText`, which includes the nav and the footer —
 * fine for proving we reached the right page, noisy as an answer. Both adapters
 * honour this identically; it is a selector WE supply, never one a model wrote.
 */
const SCOPE = arg('scope', '') ?? '';

let failures = 0;

/**
 * Timing. The number that actually matters is the DECISION latency — the design
 * goal is one network round trip per browser step, so each decision should be
 * a single call and a cache hit should be ~0ms. Browser operations are timed
 * separately because they are network-bound on Browserbase and cannot be
 * optimised from here.
 */
const timings: { label: string; ms: number; kind: 'decision' | 'browser' | 'page' }[] = [];

async function timed<T>(
  label: string,
  kind: 'decision' | 'browser' | 'page',
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    timings.push({ label, kind, ms: Date.now() - started });
  }
}

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + label + (detail ? ' -> ' + detail : ''));
}

function note(label: string, detail = ''): void {
  console.log('  [INFO] ' + label + (detail ? ' -> ' + detail : ''));
}

const ctx = (): ProviderCallContext => ({
  runId: 'run_search_probe',
  policyRule: 'read-only-public-source',
});

function adapterFor(): { adapter: BrowserAdapter; label: string } {
  if (MODE === 'browserbase') {
    return {
      adapter: createBrowserbase(config.providers.browserbase),
      label: 'browserbase (' + config.providers.browserbase.mode + ') — CLOUD',
    };
  }
  return {
    adapter: createLocalBrowser({
      ...config.providers.localbrowser,
      mode: 'live',
      channel: config.providers.localbrowser.channel ?? 'chrome',
    }),
    label: 'localbrowser (live chrome) — THIS MACHINE',
  };
}

/** Jev if it is genuinely reachable, deterministic otherwise. Never pretend. */
function buildDecider(): { decide: BrowserDecider; brain: string } {
  const jev = createJevBrowserDecider();
  const cache = createResolutionCache();
  const deterministic = createDeterministicDecider();

  if (jev) {
    // If Jev fails mid-run the step still gets a decision, and the output says
    // so loudly rather than silently degrading.
    // Report the SAME failure once. A gateway that is down is down for every
    // step, and repeating a 300-character 403 per step buries the actual run.
    let lastReported = '';
    const guarded = withFallback(jev, deterministic, (err) => {
      const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
      if (message === lastReported) return;
      lastReported = message;
      console.log(
        '\n  !! JEV UNAVAILABLE — every step below uses the deterministic fallback\n     ' +
          message.slice(0, 180) +
          '\n',
      );
    });
    return {
      decide: withResolutionCache(guarded, cache),
      brain: 'JEV (typesafe-ai/jev via AI Gateway)',
    };
  }
  return {
    decide: withResolutionCache(deterministic, cache),
    brain: 'DETERMINISTIC FALLBACK (no AI_GATEWAY_API_KEY / JEV_MODE!=live) — not a model decision',
  };
}

/**
 * The "small LLM -> text -> browser" box. Jev picked the FIELD; this writes the
 * VALUE.
 *
 * Only wired up when the text model is genuinely live. In mock mode the
 * anthropic adapter returns canned prose, which typed into a search box would
 * be worse than useless — so a mock model is treated as no model, and the
 * caller's own text is used instead. The run says which happened.
 */
/** A link whose own label carries the question's words is a search result. */
function countResultLinks(table: ElementTable, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const needed = Math.max(1, Math.ceil(terms.length / 2));
  return table.rows.filter((row) => {
    if (row.role !== 'link') return false;
    const label = row.label.toLowerCase();
    return terms.filter((t) => label.includes(t)).length >= needed;
  }).length;
}

function buildComposer(): { compose: ComposeText; writer: string } {
  const cfg = config.providers.anthropic;
  const live = cfg.mode === 'live';
  const compose = createComposeText({
    model: live ? createAnthropic(cfg) : null,
    callContext: ({ policyRule }) => ({ runId: 'run_search_probe', policyRule }),
  });
  return {
    compose,
    writer: live
      ? 'small LLM via text.model (' + cfg.mode + ')'
      : 'caller-supplied text (no live text model; ANTHROPIC_MODE=' + cfg.mode + ')',
  };
}

async function snapshot(adapter: BrowserAdapter, sessionId: string): Promise<ElementTable | null> {
  if (!adapter.snapshot) return null;
  const res = await adapter.snapshot({ sessionId }, ctx());
  return res.ok ? res.data : null;
}

async function main(): Promise<void> {
  const { adapter, label } = adapterFor();
  const { decide, brain } = buildDecider();
  const { compose, writer } = buildComposer();

  console.log('Web search probe — Person 3 slice only\n');
  console.log('  backend:  ' + label);
  console.log('  decider:  ' + brain);
  console.log('  types:    ' + writer);
  console.log('  question: ' + QUESTION);
  console.log('  start:    ' + START_URL + '\n');

  let sessionId: string | undefined;

  try {
    /* -- 1. Open. ------------------------------------------------------- */
    console.log('1. Open the search page');
    const opened = await timed('open session', 'browser', () =>
      adapter.openSession({ startUrl: START_URL }, ctx()),
    );
    check('session opened', opened.ok, opened.ok ? '' : opened.error.message);
    if (!opened.ok) return;
    sessionId = opened.data.sessionId;
    note('destination (this is the ledger proof)', String(opened.meta.destination));

    /* -- 2. THE LOOP. One request per step, all heads, Jev picks. -------- */
    //
    //                        one evaluate() request
    //                       ┌───────────────────────────┐
    //  page → element table →  operation                │
    //                       │  click_target             │
    //                       │  type_text_target         │
    //                       │  select_target, if present│
    //                       └─────────────┬─────────────┘
    //                          use the matching target
    //
    // The heads are ALL offered in ONE call and the unused ones are discarded.
    // Narrowing `allowedOperations` per step, which an earlier version of this
    // probe did, turns one speculative request into several constrained ones —
    // the exact opposite of the design.
    // Question words worth matching on. Used both to spot results and to judge
    // relevance at the end, so they are computed once.
    const terms = QUESTION.toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 3);
    const wanted = Math.max(1, Math.ceil(terms.length / 2));

    const GOAL =
      'Search for "' + QUESTION + '": type the query into the search box, then submit it.';
    const MAX_STEPS = Number(arg('steps', '4'));

    console.log('\n2. The loop — ' + MAX_STEPS + ' steps max, one request per step');
    note('goal', GOAL);

    let table: ElementTable | null = null;
    let done = false;

    for (let step = 1; step <= MAX_STEPS && !done; step += 1) {
      table = await timed('snapshot #' + step, 'page', () =>
        snapshot(adapter, sessionId as string),
      );
      if (!table) {
        check('snapshot built', false, 'step ' + step);
        return;
      }

      console.log('\n  --- step ' + step + ' --------------------------------------------');
      note('page', table.url);
      note('interactive elements', table.rows.length + ' of ' + table.totalInteractive);
      console.log(
        renderTable(table)
          .split('\n')
          .slice(0, 8)
          .map((l) => '           ' + l)
          .join('\n'),
      );

      // ONE call. Every head. No allowedOperations.
      const decision = await timed('DECISION step ' + step, 'decision', () =>
        decide({ goal: GOAL, table: table as ElementTable, typeText: QUESTION }),
      );

      const row = table.rows.find((r) => r.index === decision.index);
      note(
        'decision',
        decision.operation +
          (decision.index !== undefined ? ' [' + decision.index + ']' : '') +
          (row ? '  → "' + row.label + '"' : ''),
      );
      note('source', decision.source + '  (confidence ' + decision.confidence.toFixed(2) + ')');
      note('reason', decision.rationale);

      if (decision.operation === 'DONE') {
        note('the decider says the goal is satisfied', 'leaving the loop');
        done = true;
        break;
      }
      if (decision.operation === 'BLOCKED') {
        note('the decider says it cannot progress', 'leaving the loop');
        break;
      }
      if (!adapter.perform) return;

      // TYPE_TEXT is the one that needs a value. Jev picked the FIELD; the text
      // comes from the caller here, and from a small generative model in the
      // real system. Jev cannot write it either way.
      let text: string | undefined;
      if (decision.operation === 'TYPE_TEXT' || decision.operation === 'SELECT') {
        const composed = await timed('compose text', 'decision', () =>
          compose({ goal: GOAL, fieldLabel: row?.label ?? '', fallback: QUESTION }),
        );
        text = composed.text;
        note('text to type', JSON.stringify(text) + '  (' + composed.source + ')');
      }

      const performed = await timed('perform step ' + step, 'browser', () =>
        adapter.perform!(
          {
            sessionId: sessionId as string,
            snapshotId: (table as ElementTable).snapshotId,
            operation: decision.operation,
            ...(decision.index !== undefined ? { index: decision.index } : {}),
            ...(text !== undefined ? { text } : {}),
          },
          ctx(),
        ),
      );

      if (!performed.ok) {
        // A refusal is a NORMAL outcome on a live page — stale snapshot, an
        // occluded target. Re-snapshot and decide again rather than failing.
        note('refused', performed.error.message + ' — re-deciding');
        continue;
      }
      note('performed', performed.data.url + (performed.data.navigated ? '  (navigated)' : ''));

      // TERMINATION: look at the PAGE, not the URL.
      //
      // The first version checked for `q=` in the URL, which silently never
      // fired: html.duckduckgo.com submits by POST, so the URL is unchanged
      // even though the results are right there. The honest signal is that the
      // element table now contains links that match the question.
      const after = await timed('verify results', 'page', () =>
        snapshot(adapter, sessionId as string),
      );
      if (after && countResultLinks(after, terms) >= 2) {
        note('results are on the page', countResultLinks(after, terms) + ' matching links');
        done = true;
      }
    }

    check('the loop reached a results page', done);

    console.log('\n6. Read the results');
    // POLL, do not guess at a sleep duration. A fixed wait is either too short
    // (you read the previous page, which is the same staleness the freshness
    // guard exists for) or wastes time on every run. Re-read until the answer
    // text actually mentions the question, then stop.
    let extracted = await adapter.extract<{ title?: string; text?: string }>(
      { sessionId, instruction: SCOPE },
      ctx(),
    );
    let attempts = 1;
    while (attempts < 8) {
      const body = extracted.ok ? (extracted.data.text ?? '').toLowerCase() : '';
      if (terms.filter((t) => body.includes(t)).length >= wanted && body.length > 200) break;
      await new Promise((r) => setTimeout(r, 700));
      extracted = await adapter.extract<{ title?: string; text?: string }>(
        { sessionId, instruction: SCOPE },
        ctx(),
      );
      attempts += 1;
    }
    note('reads until the results appeared', String(attempts));

    check('extracted page text', extracted.ok, extracted.ok ? '' : extracted.error.message);

    if (extracted.ok) {
      const text = (extracted.data.text ?? '').replace(/\s+/g, ' ').trim();
      note('page title', extracted.data.title ?? '(none)');
      check('the page has substantial text', text.length > 200, text.length + ' chars');

      // Crude relevance signal: do the question's own words come back? Enough
      // to tell "we searched and got results" from "we are still on the home
      // page", which is what this probe is actually testing.
      const hits = terms.filter((t) => text.toLowerCase().includes(t));
      check(
        'the results mention the question',
        hits.length >= wanted,
        hits.length + ' of ' + terms.length + ' terms: ' + hits.join(', '),
      );

      console.log('\n--- ANSWER TEXT (first 700 chars) ' + '-'.repeat(30));
      console.log(text.slice(0, 700));
      console.log('-'.repeat(64));
    }

    // The result links are themselves interactive elements, so the element
    // table after a search IS the result list — no model needed to see it.
    const resultTable = await snapshot(adapter, sessionId);
    if (resultTable) {
      const links = resultTable.rows.filter((r) => r.role === 'link' && r.label.length > 15);
      note('result links visible in the element table', String(links.length));
      for (const link of links.slice(0, 5)) console.log('         - ' + link.label);
    }
  } finally {
    console.log('\n7. Release');
    if (sessionId) {
      const closed = await adapter.closeSession(sessionId, ctx());
      check('session released', closed.ok, closed.ok ? '' : closed.error.message);
    }
  }
}

await main();

/* -------------------------------------------------------------------------- */
/* Timing                                                                     */
/* -------------------------------------------------------------------------- */

console.log('\n--- TIMING ' + '-'.repeat(53));
for (const t of timings) {
  const marker = t.kind === 'decision' ? '*' : ' ';
  console.log('  ' + marker + ' ' + t.label.padEnd(30) + String(t.ms).padStart(6) + ' ms');
}

const sum = (kind: string): number =>
  timings.filter((t) => t.kind === kind).reduce((a, t) => a + t.ms, 0);

const decisionMs = sum('decision');
const browserMs = sum('browser');
const pageMs = sum('page');
const decisions = timings.filter((t) => t.kind === 'decision');

console.log('  ' + '-'.repeat(46));
console.log(
  '    * decisions (' +
    decisions.length +
    ')'.padEnd(18) +
    String(decisionMs).padStart(6) +
    ' ms' +
    (decisions.length
      ? '   avg ' + Math.round(decisionMs / decisions.length) + ' ms/decision'
      : ''),
);
console.log('      browser actions'.padEnd(35) + String(browserMs).padStart(6) + ' ms');
console.log('      page snapshots'.padEnd(35) + String(pageMs).padStart(6) + ' ms');
console.log(
  '      TOTAL (timed steps)'.padEnd(35) +
    String(decisionMs + browserMs + pageMs).padStart(6) +
    ' ms',
);
console.log(
  '\n  Decisions are ' +
    (decisionMs + browserMs + pageMs > 0
      ? Math.round((decisionMs / (decisionMs + browserMs + pageMs)) * 100)
      : 0) +
    '% of the timed work. The rest is the network and the page.',
);
console.log('-'.repeat(64));

console.log('\n' + (failures === 0 ? 'SEARCH PROBE PASSED' : failures + ' CHECK(S) FAILED') + '\n');
process.exit(failures === 0 ? 0 : 1);
