/**
 * LIVE PROBE for the `web` tool family: one real search and one real page read
 * through the tool plane, exactly as a graph's `tool` node would run them.
 *
 *   pnpm --filter @htn/api web:live
 *   pnpm --filter @htn/api web:live -- --q "who won the 2022 world cup"
 *
 * Needs BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID in the root .env with
 * BROWSERBASE_MODE=live. Opens (and releases) real, billed Browserbase
 * sessions -- two of them -- so it is a manual check, not part of `smoke`.
 *
 * It goes through `toolPlane()` (the composition root's own instance), not a
 * private one, so what it proves is what a graph run gets: the stopgap gate,
 * the run-attributed ledger, and session release.
 */

import { newId } from '../src/lib/ids.js';
import { store } from '../src/store/index.js';
import { toolPlane } from '../src/services/runtime.js';
import type { ToolAction } from '@htn/shared';

function arg(name: string, fallback: string): string {
  const eq = process.argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const QUERY = arg('q', 'browserbase cloud browser');
const URL_TO_READ = arg('url', 'https://example.com');
const RUN_ID = newId('run');

async function run(
  toolId: string,
  args: ToolAction['args'],
): Promise<{ ok: boolean; text: string }> {
  const plane = await toolPlane();
  const descriptor = plane.registry.get(toolId);
  if (!descriptor) throw new Error(toolId + ' is not registered in the tool plane');
  console.log('\n> ' + toolId + '  (' + descriptor.availability + ')  ' + JSON.stringify(args));

  const stepId = newId('step');
  const result = await plane.executor.execute({
    runId: RUN_ID,
    stepId,
    actionId: newId('act'),
    toolId,
    descriptorVersion: descriptor.version,
    args,
    destination: descriptor.providerId + ':' + toolId,
    dataLabels: ['private'],
    contextScope: 'private',
  });

  if (!result.ok) {
    console.log('  FAILED [' + result.error.code + '] ' + result.error.message);
    return { ok: false, text: '' };
  }
  const out = result.output as { url?: string; title?: string; text?: string };
  console.log('  ok in ' + result.latencyMs + 'ms  ->  ' + result.destination);
  console.log('  page: ' + (out.title ?? '') + '  <' + (out.url ?? '') + '>');
  const show = Number(process.env.SHOW ?? 320);
  console.log(
    '  text (' +
      (out.text ?? '').length +
      ' chars): ' +
      (out.text ?? '').slice(0, show).replace(/\s+/g, ' '),
  );
  return { ok: true, text: out.text ?? '' };
}

async function main(): Promise<void> {
  const search = await run('web.search', { query: QUERY });
  const read = await run('web.read', { url: URL_TO_READ });

  const rows = await store.listEgress(RUN_ID);
  console.log('\nledger rows for ' + RUN_ID + ' (' + rows.length + '):');
  for (const row of rows) {
    console.log(
      '  ' +
        row.providerId +
        '.' +
        row.op +
        '  ->  ' +
        row.destination +
        '  [' +
        row.decision +
        ']',
    );
  }

  const opens = rows.filter((r) => r.op === 'openSession').length;
  const closes = rows.filter((r) => r.op === 'closeSession').length;
  console.log(
    '\nsessions opened: ' +
      opens +
      ', released: ' +
      closes +
      (opens === closes ? '  (balanced)' : '  <-- LEAK'),
  );

  const good = search.ok && read.ok && search.text.length > 0 && opens === closes;
  console.log(good ? '\nALL GOOD' : '\nPROBLEM -- see above');
  process.exit(good ? 0 : 1);
}

main().catch((err) => {
  console.error('probe crashed:', err);
  process.exit(1);
});
