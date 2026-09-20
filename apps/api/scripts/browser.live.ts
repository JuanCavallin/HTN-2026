/**
 * LIVE browser verification — drives a real browser through the real adapters.
 *
 * Complements scripts/browser.check.ts, which runs against fakes and proves the
 * logic. This one proves the adapters actually work, which fakes cannot:
 * a snapshot of a real page, a real click, a real session release.
 *
 *   node scripts/smoke_browser.mjs --mode local        (needs Chrome installed)
 *   node scripts/smoke_browser.mjs --mode browserbase  (costs a real session)
 *   node scripts/smoke_browser.mjs --mode mock         (no credentials at all)
 *
 * `--mode browserbase` opens a REAL session and spends money. It always
 * releases on every exit path — that is half of what it is checking.
 */

import type { BrowserAdapter, ProviderCallContext } from '@htn/shared';
import { config } from '../src/config.js';
import { create as createLocalBrowser } from '../src/providers/localbrowser/index.js';
import { create as createBrowserbase } from '../src/providers/browserbase/index.js';
import {
  createDeterministicDecider,
  createResolutionCache,
  renderTable,
  withResolutionCache,
} from '../src/core/tools/index.js';

const MODE = (process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ??
  process.env.BROWSER_SMOKE_MODE ??
  'local') as 'local' | 'browserbase' | 'mock';

const START_URL = process.env.BROWSER_SMOKE_URL ?? 'https://example.com';

let failures = 0;
const blocked: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures += 1;
  console.log(
    '  [' + (condition ? 'PASS' : 'FAIL') + '] ' + label + (detail ? ' -> ' + detail : ''),
  );
}

/**
 * A capability we cannot exercise because a credential is absent. Reported
 * loudly but NOT counted as a failure — the suite must stay green on a machine
 * with no keys, which is the state the repo promises to run in. Silently
 * skipping it would be the dishonest option.
 */
function blockedOn(label: string, reason: string): void {
  blocked.push(label);
  console.log('  [BLOCKED] ' + label + ' -> ' + reason);
}

function isMissingLlmKey(message: string): boolean {
  return message.includes('ANTHROPIC_API_KEY');
}

function note(label: string, detail = ''): void {
  console.log('  [INFO] ' + label + (detail ? ' -> ' + detail : ''));
}

const ctx = (): ProviderCallContext => ({
  runId: 'run_browser_smoke',
  policyRule: 'read-only-public-source',
});

function adapterFor(mode: typeof MODE): { adapter: BrowserAdapter; label: string } {
  if (mode === 'browserbase') {
    return {
      adapter: createBrowserbase(config.providers.browserbase),
      label: 'browserbase (' + config.providers.browserbase.mode + ')',
    };
  }
  if (mode === 'mock') {
    return {
      adapter: createLocalBrowser({ ...config.providers.localbrowser, mode: 'mock' }),
      label: 'localbrowser (forced mock)',
    };
  }
  return {
    adapter: createLocalBrowser({
      ...config.providers.localbrowser,
      mode: 'live',
      channel: config.providers.localbrowser.channel ?? 'chrome',
    }),
    label:
      'localbrowser (live, channel=' + (config.providers.localbrowser.channel ?? 'chrome') + ')',
  };
}

async function main(): Promise<void> {
  const { adapter, label } = adapterFor(MODE);

  console.log('Live browser smoke — mode=' + MODE);
  console.log('  adapter: ' + label);
  console.log('  url:     ' + START_URL + '\n');

  const health = await adapter.health();
  check(
    'health reports ok',
    health.ok,
    health.ok ? (health.data.detail ?? '') : health.error.message,
  );
  if (!health.ok && MODE !== 'mock') {
    console.log('\nCannot continue without a healthy adapter.');
    process.exit(1);
  }

  let sessionId: string | undefined;

  // try/finally around EVERY session. TypeScript has no `async with`, and a
  // leaked session burns concurrency and money until it times out.
  try {
    console.log('\n1. Open a session');
    const opened = await adapter.openSession({ startUrl: START_URL }, ctx());
    check('openSession succeeded', opened.ok, opened.ok ? '' : opened.error.message);
    if (!opened.ok) return;

    sessionId = opened.data.sessionId;
    note('sessionId', sessionId);
    check(
      'the destination is truthful for this backend',
      MODE === 'local'
        ? opened.meta.destination === 'local://chromium'
        : opened.meta.destination !== null,
      String(opened.meta.destination),
    );
    // Browserbase live-view URLs return 410 Gone once the session stops, so it
    // has to be captured now or not at all.
    if (opened.data.liveViewUrl) {
      note('liveViewUrl', opened.data.liveViewUrl);
    } else if (MODE === 'browserbase') {
      blockedOn(
        'live-view URL',
        'needs @browserbasehq/sdk as a declared dependency (present in the store, not declared)',
      );
    } else {
      note('liveViewUrl', '(none — correct for a local browser, there is nothing to stream)');
    }

    console.log('\n2. Extract text from a real page');
    const extracted = await adapter.extract<{ title?: string; text?: string; note?: string }>(
      { sessionId, instruction: '' },
      ctx(),
    );
    if (!extracted.ok && isMissingLlmKey(extracted.error.message)) {
      // Browserbase resolves natural-language extract() with a model. The
      // element-level path below needs none, which is the point.
      blockedOn(
        'extract (natural language)',
        'needs ANTHROPIC_API_KEY; the element path in step 3 does not',
      );
    } else {
      check('extract succeeded', extracted.ok, extracted.ok ? '' : extracted.error.message);
    }
    if (extracted.ok) {
      const text = extracted.data.text ?? extracted.data.note ?? '';
      note('title', extracted.data.title ?? '(none)');
      note('first 120 chars', JSON.stringify(text.slice(0, 120)));
      check('it returned non-empty text', text.length > 0, text.length + ' chars');
    }

    console.log('\n3. Build the element table (3B-4)');
    if (!adapter.snapshot) {
      note('this backend does not implement snapshot()', 'skipping 3-5');
    } else {
      const snap = await adapter.snapshot({ sessionId }, ctx());
      check('snapshot succeeded', snap.ok, snap.ok ? '' : snap.error.message);

      if (snap.ok) {
        const table = snap.data;
        note('url', table.url);
        note('interactive elements', table.rows.length + ' of ' + table.totalInteractive);
        console.log(
          renderTable(table)
            .split('\n')
            .map((l) => '         ' + l)
            .join('\n') || '         (none)',
        );

        check('the table has a freshness token', table.snapshotId.length > 0, table.snapshotId);
        check(
          'no row leaks a selector',
          table.rows.every((r) => !r.label.includes('#') || !r.label.includes('>')),
        );
        check(
          'the table stays small (state dominates a System One request)',
          JSON.stringify(table).length < 20_000,
          JSON.stringify(table).length + ' bytes',
        );

        console.log('\n4. Decide and act');
        const cache = createResolutionCache();
        const decide = withResolutionCache(createDeterministicDecider(), cache);

        if (table.rows.length === 0) {
          note(
            'no interactive elements on this page',
            'nothing to act on — expected on example.com',
          );
        } else {
          // Derive the goal from a label that is actually on this page. A goal
          // matching nothing makes the decider fall back to "first eligible
          // target", which it correctly refuses to cache — so a hard-coded
          // goal would be testing the wrong branch.
          const goal = 'click the ' + (table.rows[0]?.label ?? 'first') + ' control';
          note('goal', goal);
          const decision = await decide({ goal, table });
          note('decision', decision.operation + ' [' + decision.index + '] via ' + decision.source);
          check(
            'a target was chosen from the offered list',
            decision.index !== undefined && table.rows.some((r) => r.index === decision.index),
          );

          if (adapter.perform && decision.index !== undefined) {
            const performed = await adapter.perform(
              {
                sessionId,
                snapshotId: table.snapshotId,
                operation: decision.operation,
                index: decision.index,
              },
              ctx(),
            );
            check(
              'perform succeeded',
              performed.ok,
              performed.ok ? performed.data.url : performed.error.message,
            );

            // 5. FRESHNESS: re-using the now-consumed snapshot MUST be refused.
            console.log('\n5. Freshness (the stale-snapshot guard)');
            const stale = await adapter.perform(
              {
                sessionId,
                snapshotId: table.snapshotId,
                operation: 'CLICK',
                index: decision.index,
              },
              ctx(),
            );
            check(
              'acting on a consumed snapshot is REFUSED',
              !stale.ok,
              stale.ok ? 'IT EXECUTED' : stale.error.message,
            );
          }

          console.log('\n6. Cache');
          const before = Date.now();
          const again = await decide({ goal, table });
          check('a repeat decision is a cache hit', again.source === 'cache', again.rationale);
          check('and costs no model call', Date.now() - before < 50, Date.now() - before + 'ms');
        }
      }
    }
    /* -- Occlusion, on a page built to be occluded. ------------------------ */
    // This guard was silently dead once already (a string-form evaluate that
    // returned `undefined`, read as "not occluded"), so it gets a test that can
    // only pass if it actually runs. A visible, enabled button under a
    // full-screen overlay is exactly the cookie-banner case.
    if (MODE === 'local' && adapter.snapshot && adapter.perform) {
      console.log('\n6b. Occlusion (a modal covering the target)');
      const page =
        'data:text/html,' +
        encodeURIComponent(
          '<button id="b" style="position:absolute;top:50px;left:50px">Continue</button>' +
            '<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999">cookies</div>',
        );

      let occludedSession: string | undefined;
      try {
        const opened = await adapter.openSession({ startUrl: page }, ctx());
        if (opened.ok) {
          occludedSession = opened.data.sessionId;
          const snap = await adapter.snapshot({ sessionId: occludedSession }, ctx());
          check(
            'the covered button is still listed',
            snap.ok && snap.data.rows.length > 0,
            snap.ok ? snap.data.rows.map((r) => r.label).join(', ') : snap.error.message,
          );

          if (snap.ok && snap.data.rows.length > 0) {
            const attempt = await adapter.perform(
              {
                sessionId: occludedSession,
                snapshotId: snap.data.snapshotId,
                operation: 'CLICK',
                index: snap.data.rows[0]!.index,
              },
              ctx(),
            );
            check(
              'clicking an OCCLUDED target is refused',
              !attempt.ok && attempt.error.message === 'occluded',
              attempt.ok ? 'IT CLICKED THROUGH THE OVERLAY' : attempt.error.message,
            );
          }
        }
      } finally {
        if (occludedSession) await adapter.closeSession(occludedSession, ctx());
      }
    }
  } finally {
    console.log('\n7. Release');
    if (sessionId) {
      const closed = await adapter.closeSession(sessionId, ctx());
      check('closeSession succeeded', closed.ok, closed.ok ? '' : closed.error.message);
      // Idempotent: a finally block must be able to call this unconditionally.
      const again = await adapter.closeSession(sessionId, ctx());
      check('closing twice is a no-op, not an error', again.ok);
    } else {
      note('no session was opened', 'nothing to release');
    }
  }
}

await main();

/**
 * Repeated live runs — the "browser reliability across 10+ runs" criterion.
 *
 * Fakes already prove the executor closes what it opens. This proves a REAL
 * browser does, which is a different claim: a leaked Chrome process or an
 * unreleased Browserbase session only shows up against the real thing.
 *
 *   BROWSER_SMOKE_REPEAT=10 pnpm --filter @htn/api check:browser:live
 */
const REPEAT = Number(process.env.BROWSER_SMOKE_REPEAT ?? 0);

if (REPEAT > 0) {
  console.log('\n8. Reliability — ' + REPEAT + ' consecutive real sessions');
  const { adapter } = adapterFor(MODE);
  let opened = 0;
  let released = 0;
  let extracted = 0;

  for (let i = 0; i < REPEAT; i += 1) {
    let id: string | undefined;
    try {
      const session = await adapter.openSession({ startUrl: START_URL }, ctx());
      if (!session.ok) {
        console.log('  [FAIL] run ' + (i + 1) + ' could not open -> ' + session.error.message);
        failures += 1;
        continue;
      }
      opened += 1;
      id = session.data.sessionId;

      if (adapter.snapshot) {
        const snap = await adapter.snapshot({ sessionId: id }, ctx());
        if (snap.ok) extracted += 1;
      }
    } finally {
      if (id) {
        const closed = await adapter.closeSession(id, ctx());
        if (closed.ok) released += 1;
      }
    }
  }

  check('every run opened a session', opened === REPEAT, opened + '/' + REPEAT);
  check('every run built an element table', extracted === REPEAT, extracted + '/' + REPEAT);
  check(
    'every session was released — nothing leaked',
    released === opened,
    released + ' released of ' + opened + ' opened',
  );
}

if (blocked.length > 0) {
  console.log('\nBlocked on a missing credential or dependency (not a defect):');
  for (const item of blocked) console.log('  - ' + item);
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
