/**
 * Browser smoke launcher — Person 3's verification entry point.
 *
 * Matches scripts/smoke.mjs in spirit but NOT in mechanism: smoke.mjs drives a
 * running API over HTTP, and the browser work has no HTTP surface of its own
 * yet (routes are Person 1's). So this runs the checks in-process through the
 * api package's existing tsx — no new test dependency, nothing to start first.
 *
 *   node scripts/smoke_browser.mjs                  # fakes only, no keys, ~1s
 *   node scripts/smoke_browser.mjs --mode mock      # + the adapter in mock mode
 *   node scripts/smoke_browser.mjs --mode local     # + REAL Chrome
 *   node scripts/smoke_browser.mjs --mode browserbase   # + a REAL cloud session
 *
 * `--mode browserbase` opens a real session and spends money. Everything else
 * runs with zero credentials.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const modeArg = process.argv.find((a) => a.startsWith('--mode'));
const mode = modeArg ? (modeArg.split('=')[1] ?? process.argv[process.argv.indexOf(modeArg) + 1]) : null;

function run(label, args, env = {}) {
  return new Promise((resolve) => {
    console.log('\n' + '='.repeat(70));
    console.log(label);
    console.log('='.repeat(70));
    const child = spawn('pnpm', args, {
      cwd: root,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, ...env },
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

let failed = 0;

// Always run the logic checks. They need nothing and catch the most.
failed += (await run('Logic checks (fakes, no credentials)', ['--filter', '@htn/api', 'check:browser'])) === 0 ? 0 : 1;

if (mode) {
  const label =
    mode === 'browserbase'
      ? 'LIVE Browserbase session (costs money)'
      : mode === 'local'
        ? 'LIVE local Chrome'
        : 'Adapter in mock mode';
  failed +=
    (await run(label, ['--filter', '@htn/api', 'check:browser:live'], {
      BROWSER_SMOKE_MODE: mode,
    })) === 0
      ? 0
      : 1;
} else {
  console.log('\nSkipped the live adapter run. Add --mode local | mock | browserbase.');
}

console.log('\n' + (failed === 0 ? 'SMOKE PASSED' : failed + ' SUITE(S) FAILED'));
process.exit(failed === 0 ? 0 : 1);
