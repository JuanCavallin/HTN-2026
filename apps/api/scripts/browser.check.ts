/**
 * Person 3 checks — the tool registry (3A) and the browser executor (3B).
 *
 * In-process, against recording fakes, through the api package's existing tsx.
 * No test runner is added: that is root tooling and Person 4 owns it. These are
 * genuinely unit tests and deserve vitest when someone adds it; until then this
 * file is the evidence, and it runs in about a second with no API keys.
 *
 *   pnpm --filter @htn/api check:browser
 *
 * WHAT IS PROVED HERE, and why each one is worth a check:
 *   - all four fail-closed authorization paths block (deny/throw/timeout/missing)
 *   - a local-only step NEVER opens a Browserbase session
 *   - a session closes after a mid-run error and on cancellation
 *   - a REVISED payload is what executes, not the one a human edited away
 *   - the decider's choice is constrained to the offered candidate list
 *   - low confidence ESCALATES rather than proceeding
 *   - a cache hit costs ZERO model calls
 *   - no Browserbase descriptor allows local_only or secret
 *   - an empty catalog works end to end
 *   - unselected / unavailable / simulated tools are blocked at execution
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  AuthorizeAction,
  BrowserAdapter,
  ElementTable,
  ProviderCallContext,
  ToolAction,
  ToolAuthorization,
  ToolDescriptor,
} from '@htn/shared';
import {
  browserDescriptors,
  browserbaseDescriptorsAreSafe,
  createBrowserExecutor,
  createDeterministicDecider,
  createResolutionCache,
  createToolDispatcher,
  createToolRegistry,
  eligibleRows,
  loadPluginManifests,
  parseManifest,
  toCriteria,
  withResolutionCache,
  escalateForConfidence,
  type BrowserDecider,
} from '../src/core/tools/index.js';

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures += 1;
  console.log(
    '  [' + (condition ? 'PASS' : 'FAIL') + '] ' + label + (detail ? ' -> ' + detail : ''),
  );
}

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

interface FakeLog {
  opened: number;
  closed: number;
  performed: { operation: string; index?: number; text?: string }[];
  destinations: string[];
}

function meta(op: string, destination: string) {
  return {
    provider: 'localbrowser' as const,
    op,
    mode: 'mock' as const,
    latencyMs: 1,
    destination,
  };
}

const TABLE_ROWS = [
  { index: 1, role: 'textbox', label: 'Email', clickable: true, editable: true, selectable: false },
  {
    index: 2,
    role: 'button',
    label: 'Sign in',
    clickable: true,
    editable: false,
    selectable: false,
  },
  {
    index: 3,
    role: 'link',
    label: 'Register',
    clickable: true,
    editable: false,
    selectable: false,
  },
];

/**
 * A browser adapter that records what it was asked to do. Two of these — one
 * per destination — is how "local-only never reached Browserbase" is PROVED
 * rather than asserted: the remote fake's counters must stay at zero.
 */
function fakeBrowser(
  destination: string,
  behaviour: { failOnPerform?: boolean; hangMs?: number } = {},
): { adapter: BrowserAdapter; log: FakeLog } {
  const log: FakeLog = { opened: 0, closed: 0, performed: [], destinations: [] };
  let snapshotId = 'snap_1';
  const live = new Set<string>();

  const adapter: BrowserAdapter = {
    id: 'localbrowser',
    mode: 'mock',
    capabilities: ['browser.local'],
    async health() {
      return { ok: true, data: {}, meta: meta('health', destination) };
    },
    async invoke(op) {
      return {
        ok: false,
        error: { code: 'BAD_INPUT', message: 'no', retryable: false },
        meta: meta(op, destination),
      };
    },
    async openSession() {
      log.opened += 1;
      log.destinations.push(destination);
      const sessionId = 's' + log.opened;
      live.add(sessionId);
      return { ok: true, data: { sessionId }, meta: meta('openSession', destination) };
    },
    async act() {
      return { ok: true, data: { url: 'https://example.test' }, meta: meta('act', destination) };
    },
    async extract<T = unknown>() {
      // Generic, matching BrowserAdapter.extract. The cast is confined to this
      // fake: a stub cannot know the caller's T, and the executor only reads
      // the result opaquely.
      return { ok: true as const, data: { text: 'ok' } as T, meta: meta('extract', destination) };
    },
    async snapshot(input) {
      const table: ElementTable = {
        snapshotId,
        sessionId: input.sessionId,
        url: 'https://example.test/login',
        title: 'Login',
        capturedAt: new Date().toISOString(),
        rows: TABLE_ROWS,
        truncated: false,
        totalInteractive: TABLE_ROWS.length,
      };
      return { ok: true, data: table, meta: meta('snapshot', destination) };
    },
    async perform(input) {
      if (behaviour.hangMs) await new Promise((r) => setTimeout(r, behaviour.hangMs));
      if (behaviour.failOnPerform) throw new Error('boom mid-action');
      if (input.snapshotId !== snapshotId) {
        return {
          ok: false,
          error: { code: 'BAD_INPUT', message: 'stale_snapshot', retryable: true },
          meta: meta('perform', destination),
        };
      }
      log.performed.push({
        operation: input.operation,
        ...(input.index !== undefined ? { index: input.index } : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
      });
      snapshotId = 'snap_' + (log.performed.length + 1);
      return {
        ok: true,
        data: {
          operation: input.operation,
          index: input.index,
          url: 'https://example.test/next',
          navigated: true,
        },
        meta: meta('perform', destination),
      };
    },
    async closeSession(sessionId) {
      if (live.delete(sessionId)) log.closed += 1;
      return { ok: true, data: null, meta: meta('closeSession', destination) };
    },
  };

  return { adapter, log };
}

const ctx = (): ProviderCallContext => ({ runId: 'run_test', policyRule: 'check' });

function action(overrides: Partial<ToolAction> = {}): ToolAction {
  return {
    runId: 'run_test',
    stepId: 'step_1',
    actionId: 'act_1',
    toolId: 'localbrowser.click',
    descriptorVersion: '1.0.0',
    args: { goal: 'click sign in' },
    destination: 'local://chromium',
    dataLabels: ['public'],
    ...overrides,
  };
}

const allow: AuthorizeAction = async () => ({
  outcome: 'allow',
  reason: 'reversible-action-auto',
  riskClass: 'auto',
  providerId: 'localbrowser',
});

function makeExecutor(
  authorize: AuthorizeAction,
  localFake = fakeBrowser('local://chromium'),
  remoteFake = fakeBrowser('https://connect.usw2.browserbase.com'),
  decide: BrowserDecider = createDeterministicDecider(),
) {
  const executor = createBrowserExecutor({
    provider: ((capability: string) =>
      capability === 'browser.local' ? localFake.adapter : remoteFake.adapter) as never,
    authorize,
    decide,
    callContext: ctx,
  });
  return { executor, local: localFake, remote: remoteFake };
}

/* -------------------------------------------------------------------------- */

console.log('Person 3 checks — tool registry (3A) + browser executor (3B)\n');

/* == 1. The four fail-closed authorization paths ========================== */
{
  console.log('1. Fail-closed authorization (all four paths must BLOCK)');

  const deny: AuthorizeAction = async () => ({
    outcome: 'deny',
    reason: 'rejected-by-human',
    riskClass: 'ask_human',
  });
  const throws: AuthorizeAction = async () => {
    throw new Error('gate exploded');
  };
  const hangs: AuthorizeAction = () => new Promise(() => {});
  const missing = (async () => undefined) as unknown as AuthorizeAction;

  for (const [name, gate] of [
    ['explicit deny', deny],
    ['thrown error', throws],
    ['missing response', missing],
  ] as const) {
    const { executor, local, remote } = makeExecutor(gate);
    const result = await executor.execute(action());
    check(
      name + ' blocks',
      !result.ok && result.error.code === 'BLOCKED',
      result.ok ? 'EXECUTED' : result.error.message.slice(0, 70),
    );
    check(name + ' opened no session at all', local.log.opened === 0 && remote.log.opened === 0);
  }

  // The timeout path needs its own executor so the short budget is used.
  {
    const localFake = fakeBrowser('local://chromium');
    const remoteFake = fakeBrowser('https://connect.usw2.browserbase.com');
    const executor = createBrowserExecutor({
      provider: ((c: string) =>
        c === 'browser.local' ? localFake.adapter : remoteFake.adapter) as never,
      authorize: hangs,
      decide: createDeterministicDecider(),
      callContext: ctx,
    });
    // guardAuthorization's default budget is 10s; prove the mechanism with a
    // gate that never answers and a directly-invoked guard instead of waiting.
    const { guardAuthorization } = await import('../src/core/tools/authorize.js');
    const guarded = await guardAuthorization(hangs, action(), undefined, 50);
    check(
      'timeout blocks',
      guarded.authorization.outcome === 'deny' && guarded.failure === 'timeout',
      guarded.authorization.reason,
    );
    void executor;
  }

  // An unrecognised outcome value must NOT be read as permission.
  {
    const weird = (async () => ({ outcome: 'probably' })) as unknown as AuthorizeAction;
    const { guardAuthorization } = await import('../src/core/tools/authorize.js');
    const guarded = await guardAuthorization(weird, action());
    check(
      'an unknown outcome value is not treated as allow',
      guarded.authorization.outcome === 'deny' && guarded.failure === 'missing_response',
    );
  }
}

/* == 2. Local-only never reaches Browserbase ============================== */
{
  console.log('\n2. Destination policy (seam 3)');

  const { executor, local, remote } = makeExecutor(allow);
  const result = await executor.execute(
    action({ contextScope: 'local_only', dataLabels: ['secret'] }),
  );

  check('a local-only step executes', result.ok, result.ok ? '' : result.error.message);
  check('it opened a LOCAL session', local.log.opened === 1);
  check(
    'it NEVER touched Browserbase',
    remote.log.opened === 0 && remote.log.performed.length === 0,
  );
  check(
    'the recorded destination is local',
    result.ok && result.destination === 'local://chromium',
    result.ok ? result.destination : '',
  );

  // The stopgap gate must refuse to send local-only data to a remote host even
  // when the proposal asks for it.
  const { createStopgapAuthorizeAction, guardAuthorization } =
    await import('../src/core/tools/authorize.js');
  const gate = createStopgapAuthorizeAction();
  const guarded = await guardAuthorization(
    gate,
    action({ contextScope: 'local_only', destination: 'https://connect.usw2.browserbase.com' }),
  );
  check(
    'policy denies local-only data bound for a remote host',
    guarded.authorization.outcome === 'deny',
    guarded.authorization.reason,
  );

  // And a backend the executor cannot serve is a BLOCK, not a silent default.
  const namesUnknown: AuthorizeAction = async () => ({
    outcome: 'allow',
    reason: 'test',
    riskClass: 'auto',
    providerId: 'composio',
  });
  const unknown = makeExecutor(namesUnknown);
  const unknownResult = await unknown.executor.execute(action());
  check(
    'a backend the executor cannot serve blocks instead of defaulting',
    !unknownResult.ok && unknownResult.error.reason === 'no-permitted-backend',
  );
}

/* == 3. Session lifecycle ================================================= */
{
  console.log('\n3. Session lifecycle (3B-7)');

  // Mid-action error.
  {
    const localFake = fakeBrowser('local://chromium', { failOnPerform: true });
    const { executor, local } = makeExecutor(allow, localFake);
    const result = await executor.execute(action());
    check('a mid-action error fails the action', !result.ok);
    check(
      'the session was still closed',
      local.log.opened === 1 && local.log.closed === 1,
      'opened=' + local.log.opened + ' closed=' + local.log.closed,
    );
  }

  // Cancellation.
  {
    const localFake = fakeBrowser('local://chromium', { hangMs: 40 });
    const { executor, local } = makeExecutor(allow, localFake);
    const controller = new AbortController();
    const pending = executor.execute(action(), controller.signal);
    controller.abort();
    await pending;
    check(
      'a cancelled run still closes its session',
      local.log.closed === local.log.opened && local.log.opened === 1,
      'opened=' + local.log.opened + ' closed=' + local.log.closed,
    );
  }

  // Ten consecutive runs.
  {
    const localFake = fakeBrowser('local://chromium');
    const { executor, local } = makeExecutor(allow, localFake);
    for (let i = 0; i < 10; i += 1) {
      await executor.execute(action({ actionId: 'act_' + i }));
    }
    check(
      '10 consecutive runs leak no sessions',
      local.log.opened === 10 && local.log.closed === 10,
      'opened=' + local.log.opened + ' closed=' + local.log.closed,
    );
  }

  // browser.open deliberately hands the session to the caller.
  {
    const localFake = fakeBrowser('local://chromium');
    const { executor, local } = makeExecutor(allow, localFake);
    const result = await executor.execute(action({ toolId: 'localbrowser.open' }));
    check('browser.open returns a session id', result.ok);
    check('browser.open does NOT close what it handed back', local.log.closed === 0);

    if (result.ok) {
      const sessionId = (result.output as { sessionId: string }).sessionId;
      await executor.execute(action({ toolId: 'localbrowser.close', args: { sessionId } }));
      check('browser.close releases it', local.log.closed === 1);
    }
  }
}

/* == 4. Revised payload ==================================================== */
{
  console.log('\n4. Human revision');

  const revising: AuthorizeAction = async () => ({
    outcome: 'allow',
    reason: 'human-approved-revision',
    riskClass: 'ask_human',
    providerId: 'localbrowser',
    revisedArguments: { goal: 'type into email', text: 'REVISED@example.test' },
  });

  const localFake = fakeBrowser('local://chromium');
  const { executor, local } = makeExecutor(revising, localFake);
  const result = await executor.execute(
    action({ toolId: 'localbrowser.type', args: { goal: 'type into email', text: 'ORIGINAL' } }),
  );

  check('the revised action executes', result.ok, result.ok ? '' : result.error.message);
  check(
    'what actually ran is the REVISED text, not the original',
    local.log.performed[0]?.text === 'REVISED@example.test',
    JSON.stringify(local.log.performed[0]),
  );
}

/* == 5. The decision is constrained to the offered list ==================== */
{
  console.log('\n5. Decisions are constrained (3B-5)');

  const table: ElementTable = {
    snapshotId: 'snap_1',
    sessionId: 's1',
    url: 'https://example.test/login',
    title: 'Login',
    capturedAt: new Date().toISOString(),
    rows: TABLE_ROWS,
    truncated: false,
    totalInteractive: 3,
  };

  const criteria = toCriteria(eligibleRows(table, 'CLICK'));
  check('criteria keys are integer indices', Object.keys(criteria ?? {}).join(',') === '1,2,3');
  check(
    'no criteria value contains a selector',
    Object.values(criteria ?? {}).every((v) => !v.includes('#') && !v.includes('>')),
  );
  check('TYPE_TEXT offers only editable rows', eligibleRows(table, 'TYPE_TEXT').length === 1);
  check(
    'an empty eligible set yields null criteria, not a 1-option question',
    toCriteria(eligibleRows(table, 'SELECT')) === null,
  );

  const decider = createDeterministicDecider();
  const decision = await decider({ goal: 'click the Sign in button', table });
  check(
    'the deterministic decider picks from the offered indices',
    decision.index !== undefined && table.rows.some((r) => r.index === decision.index),
    JSON.stringify({ op: decision.operation, index: decision.index }),
  );
  check('it matched the right element', decision.index === 2, 'index=' + decision.index);
  check('it labels its source truthfully', decision.source === 'deterministic');

  // An out-of-list index must be rejected by the executor even if a decider
  // returns one — the offered list is a contract, not a suggestion.
  const rogue: BrowserDecider = async () => ({
    operation: 'CLICK',
    index: 99,
    confidence: 0.9,
    source: 'jev',
    rationale: 'rogue',
  });
  const { executor } = makeExecutor(allow, fakeBrowser('local://chromium'), undefined, rogue);
  const rogueResult = await executor.execute(action());
  check(
    'an index that was never offered is refused',
    !rogueResult.ok && rogueResult.error.reason === 'index-not-offered',
  );
}

/* == 6. Confidence escalates, never de-escalates ========================== */
{
  console.log('\n6. Confidence (3B-5)');

  check(
    'low confidence turns verify into ask_human',
    escalateForConfidence('verify', 0.3).riskClass === 'ask_human',
  );
  check(
    'high confidence leaves verify alone',
    escalateForConfidence('verify', 0.95).riskClass === 'verify',
  );
  check(
    'confidence NEVER downgrades ask_human',
    escalateForConfidence('ask_human', 0.99).riskClass === 'ask_human',
  );
  check(
    'confidence never upgrades auto either (reversibility decided that)',
    escalateForConfidence('auto', 0.1).riskClass === 'auto',
  );

  // End to end: a low-confidence decision on a `verify` action re-gates, and a
  // gate that then denies must stop the action.
  let gateCalls = 0;
  const denyOnSecond: AuthorizeAction = async () => {
    gateCalls += 1;
    return gateCalls === 1
      ? {
          outcome: 'allow',
          reason: 'recoverable-action-verified',
          riskClass: 'verify',
          providerId: 'localbrowser',
        }
      : { outcome: 'deny', reason: 'escalated-and-rejected', riskClass: 'ask_human' };
  };
  const unsure: BrowserDecider = async () => ({
    operation: 'CLICK',
    index: 2,
    confidence: 0.35,
    source: 'jev',
    rationale: 'coin flip',
  });
  const localFake = fakeBrowser('local://chromium');
  const { executor } = makeExecutor(denyOnSecond, localFake, undefined, unsure);
  const result = await executor.execute(action());
  check(
    'a low-confidence verify action re-gates and blocks when refused',
    !result.ok && result.error.reason === 'low-confidence-escalated',
    result.ok ? 'EXECUTED' : (result.error.reason ?? ''),
  );
  check('it performed nothing', localFake.log.performed.length === 0);
  check('and still closed its session', localFake.log.closed === localFake.log.opened);
}

/* == 7. The cache makes zero model calls ================================== */
{
  console.log('\n7. Resolution cache (a hit costs no model call)');

  let calls = 0;
  const counting: BrowserDecider = async () => {
    calls += 1;
    return { operation: 'CLICK', index: 2, confidence: 0.9, source: 'jev', rationale: 'x' };
  };
  const cache = createResolutionCache();
  const cached = withResolutionCache(counting, cache);

  const table: ElementTable = {
    snapshotId: 'snap_1',
    sessionId: 's1',
    url: 'https://example.test/login?q=1',
    title: 'Login',
    capturedAt: new Date().toISOString(),
    rows: TABLE_ROWS,
    truncated: false,
    totalInteractive: 3,
  };

  const first = await cached({ goal: 'sign in', table });
  check('the first call reaches the decider', calls === 1 && first.source === 'jev');

  const second = await cached({ goal: 'sign in', table });
  check('the second call makes ZERO model calls', calls === 1, 'calls=' + calls);
  check('and is labelled as a cache hit', second.source === 'cache');
  check('and resolves the same element', second.index === 2);

  // A different query string is the same page — the key drops it on purpose.
  const shifted: ElementTable = {
    ...table,
    url: 'https://example.test/login?q=2',
    rows: [
      {
        index: 1,
        role: 'button',
        label: 'Accept cookies',
        clickable: true,
        editable: false,
        selectable: false,
      },
      ...TABLE_ROWS.map((r) => ({ ...r, index: r.index + 1 })),
    ],
  };
  const third = await cached({ goal: 'sign in', table: shifted });
  check(
    'a shifted index still hits, because the cache keys on identity not index',
    calls === 1 && third.source === 'cache' && third.index === 3,
    'calls=' + calls + ' index=' + third.index,
  );

  // A genuine miss re-invokes and rewrites, rather than acting on a dead entry.
  const gone: ElementTable = { ...table, rows: [TABLE_ROWS[0]!] };
  await cached({ goal: 'sign in', table: gone });
  check('a vanished element re-invokes the decider', calls === 2, 'calls=' + calls);
}

/* == 8. Descriptors ======================================================== */
{
  console.log('\n8. Descriptors (the Browserbase privacy rule)');

  const descriptors = browserDescriptors();
  check(
    'the browser family registers descriptors',
    descriptors.length > 0,
    String(descriptors.length),
  );
  check(
    'NO Browserbase descriptor allows local_only or secret',
    browserbaseDescriptorsAreSafe(descriptors),
  );
  check(
    'the local backend DOES allow local_only and secret',
    descriptors
      .filter((d) => d.providerId === 'localbrowser')
      .every(
        (d) =>
          d.allowedContextScopes.includes('local_only') && d.allowedDataLabels.includes('secret'),
      ),
  );
  check(
    'submit is ask_human on both backends',
    descriptors.filter((d) => d.id.endsWith('.submit')).every((d) => d.riskClass === 'ask_human'),
  );
  check(
    'every descriptor carries a schema POINTER, never a schema',
    descriptors.every((d) => typeof d.schemaRef === 'string' && d.schemaRef.startsWith('schema:')),
  );
  check(
    'no descriptor carries a credential VALUE',
    descriptors.every((d) => !d.credentialRef || /^[A-Z][A-Z0-9_]*$/.test(d.credentialRef)),
  );
}

/* == 9. Registry and selection, including an empty catalog ================= */
{
  console.log('\n9. Registry + select_tool_metadata (3A)');

  const empty = createToolRegistry();
  check(
    'an empty catalog returns nothing and does not throw',
    empty.selectToolMetadata().length === 0,
  );
  check('an empty catalog reports zero counts', empty.counts().total === 0);
  check('an empty catalog has no families', empty.families().length === 0);
  check('schemasFor on an empty catalog returns []', empty.schemasFor(['a.b']).length === 0);

  const registry = createToolRegistry();
  registry.registerAll(browserDescriptors());

  const all = registry.selectToolMetadata();
  check('candidates come back for a populated catalog', all.length > 0, String(all.length));
  check(
    'metadata carries NO schemaRef, credentialRef or executorRef',
    all.every((m) => !('schemaRef' in m) && !('credentialRef' in m) && !('executorRef' in m)),
  );

  const localOnly = registry.selectToolMetadata({ contextScope: 'local_only' });
  check(
    'a local_only step sees no Browserbase candidate at all',
    localOnly.length > 0 && localOnly.every((m) => m.providerId !== 'browserbase'),
    localOnly.length + ' candidates',
  );

  const secret = registry.selectToolMetadata({ dataLabels: ['secret'] });
  check(
    'a secret-carrying step sees no Browserbase candidate',
    secret.every((m) => m.providerId !== 'browserbase'),
  );

  const unauth = createToolRegistry();
  unauth.registerAll(browserDescriptors({ browserbaseAvailable: false }));
  check(
    'an unauthenticated provider is excluded from candidates',
    unauth.selectToolMetadata().every((m) => m.providerId !== 'browserbase'),
  );

  check(
    'family filtering works',
    registry.selectToolMetadata({ families: ['nonexistent'] }).length === 0,
  );
  check('limit caps the candidate list', registry.selectToolMetadata({ limit: 3 }).length === 3);
  check(
    'schemasFor returns full descriptors for the final set',
    registry.schemasFor(['localbrowser.open'])[0]?.schemaRef !== undefined,
  );
  check(
    'ids are normalised',
    (() => {
      const r = createToolRegistry();
      r.register({ ...browserDescriptors()[0]!, id: 'Local Browser/Open' });
      return r.has('local.browser.open');
    })(),
  );
}

/* == 10. Dispatcher blocks ================================================ */
{
  console.log('\n10. Execution blocks (3A acceptance)');

  const registry = createToolRegistry();
  registry.registerAll(browserDescriptors());

  const simulated: ToolDescriptor = {
    ...browserDescriptors()[0]!,
    id: 'fixture.send',
    providerId: 'fixture',
    family: 'mail',
    simulated: true,
    transport: 'simulated',
  };
  registry.register(simulated);

  const localFake = fakeBrowser('local://chromium');
  const browserExecutor = createBrowserExecutor({
    provider: (() => localFake.adapter) as never,
    authorize: allow,
    decide: createDeterministicDecider(),
    callContext: ctx,
  });

  const dispatcher = createToolDispatcher({
    registry,
    executors: [browserExecutor],
    selectedTools: (stepId) => (stepId === 'restricted' ? ['localbrowser.extract'] : undefined),
  });

  const unknown = await dispatcher.execute(action({ toolId: 'nope.nope' }));
  check('an unknown tool is blocked', !unknown.ok && unknown.error.code === 'UNKNOWN_TOOL');

  const unselected = await dispatcher.execute(
    action({ stepId: 'restricted', toolId: 'localbrowser.click' }),
  );
  check(
    'an UNSELECTED tool is blocked at execution',
    !unselected.ok && unselected.error.reason === 'tool-not-selected',
  );

  const fixture = await dispatcher.execute(action({ toolId: 'fixture.send', args: {} }));
  check(
    'a simulated fixture REFUSES to execute',
    !fixture.ok && fixture.error.code === 'SIMULATED',
  );

  const stale = await dispatcher.execute(action({ descriptorVersion: '0.0.1' }));
  check(
    'a descriptor-version mismatch blocks (approvals bind to it)',
    !stale.ok && stale.error.reason === 'descriptor-version-mismatch',
  );

  const unavailable = createToolRegistry();
  unavailable.registerAll(browserDescriptors({ localAvailable: false }));
  const d2 = createToolDispatcher({ registry: unavailable, executors: [browserExecutor] });
  const blockedResult = await d2.execute(action());
  check(
    'an unavailable tool is blocked',
    !blockedResult.ok && blockedResult.error.code === 'UNAVAILABLE',
  );

  check('nothing above reached the browser', localFake.log.opened === 0);

  const selected = await dispatcher.execute(
    action({ stepId: 'restricted', toolId: 'localbrowser.extract', args: { instruction: '' } }),
  );
  check('a SELECTED tool does execute', selected.ok, selected.ok ? '' : selected.error.message);
}

/* == 11. Manifests ======================================================== */
{
  console.log('\n11. Plugin manifests (3A-3)');

  const here = dirname(fileURLToPath(import.meta.url));
  const pluginDir = join(here, '..', '..', '..', 'config', 'plugins');
  const loaded = await loadPluginManifests(pluginDir);

  check('the browser manifest loads', loaded.loaded.length >= 1, loaded.loaded.join(', '));
  check('nothing was skipped', loaded.skipped.length === 0, JSON.stringify(loaded.skipped));
  check(
    'it produced descriptors',
    loaded.descriptors.length > 0,
    String(loaded.descriptors.length),
  );
  check(
    'no loaded descriptor carries a credential VALUE',
    loaded.descriptors.every((d) => !d.credentialRef || /^[A-Z][A-Z0-9_]*$/.test(d.credentialRef)),
  );

  const missingDir = await loadPluginManifests(join(here, 'does-not-exist'));
  check('a missing plugin directory is not an error', missingDir.descriptors.length === 0);

  // A pasted secret must fail validation loudly.
  const withSecret = parseManifest({
    manifestVersion: 1,
    pluginId: 'x',
    version: '1',
    providerId: 'x',
    family: 'x',
    displayName: 'x',
    transport: 'http',
    executorRef: 'executor:http',
    credentialRef: 'sk-live-abc123',
    tools: [{ operation: 'do', description: 'd', schemaRef: 's' }],
  });
  check(
    'a credential VALUE in credentialRef is rejected',
    withSecret.manifest === undefined,
    withSecret.error ?? '',
  );

  const bad = parseManifest({ manifestVersion: 2, pluginId: 'x' });
  check('a wrong manifestVersion is rejected', bad.manifest === undefined);
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
