import assert from 'node:assert/strict';
import type {
  BrowserAdapter,
  BrowserPerformResult,
  ElementTable,
  ProviderCallContext,
  ToolAction,
} from '@htn/shared';
import { createBrowserExecutor } from '../src/core/tools/browser.js';
import {
  browserbaseDescriptorsAreSafe,
  browserToolRegistrations,
} from '../src/core/tools/browserDescriptors.js';

const calls = { opened: 0, extracted: 0, snapped: 0, performed: 0, closed: 0 };
let lastExtractionInstruction: string | undefined;
let lastStartUrl: string | undefined;
const table: ElementTable = {
  snapshotId: 'snap_1',
  sessionId: 'session_1',
  url: 'about:blank',
  title: 'Check page',
  capturedAt: new Date().toISOString(),
  rows: [
    {
      index: 1,
      role: 'button',
      label: 'Continue',
      clickable: true,
      editable: false,
      selectable: false,
    },
  ],
  truncated: false,
  totalInteractive: 1,
};

const adapter: BrowserAdapter = {
  id: 'localbrowser',
  mode: 'live',
  capabilities: ['browser.local'],
  async health() {
    return { ok: true, data: {}, meta: meta('health') };
  },
  async invoke() {
    return { ok: false, error: failure('not used'), meta: meta('invoke') };
  },
  async openSession(input) {
    calls.opened += 1;
    lastStartUrl = input.startUrl;
    return {
      ok: true,
      data: { sessionId: 'session_' + calls.opened.toString() },
      meta: meta('openSession'),
    };
  },
  async act() {
    return { ok: false, error: failure('not used'), meta: meta('act') };
  },
  async extract<T>(input: { sessionId: string; instruction: string }) {
    calls.extracted += 1;
    lastExtractionInstruction = input.instruction;
    return { ok: true, data: { text: 'result' } as T, meta: meta('extract') };
  },
  async snapshot(input) {
    calls.snapped += 1;
    return {
      ok: true,
      data: { ...table, sessionId: input.sessionId },
      meta: meta('snapshot'),
    };
  },
  async perform(input) {
    calls.performed += 1;
    const result: BrowserPerformResult = {
      operation: input.operation,
      index: input.index,
      url: 'about:blank',
      navigated: false,
    };
    return { ok: true, data: result, meta: meta('perform') };
  },
  async closeSession() {
    calls.closed += 1;
    return { ok: true, data: null, meta: meta('closeSession') };
  },
};

const registrations = browserToolRegistrations({
  localAvailable: true,
  browserbaseAvailable: true,
});
assert.equal(registrations.length, 16);
assert.equal(browserbaseDescriptorsAreSafe(registrations), true);
assert.equal(
  registrations.find((item) => item.descriptor.id === 'browserbase.submit')?.descriptor
    .reversibility,
  'irreversible',
);

const executor = createBrowserExecutor({
  provider: () => adapter,
  decide: async () => ({
    operation: 'CLICK',
    index: 1,
    confidence: 0.95,
    source: 'jev',
    rationale: 'check decision',
  }),
});

const context: ProviderCallContext = {
  runId: 'run_browser_check',
  stepId: 'step_browser_check',
  policyRule: 'authorized-tool-action',
};
const clicked = await executor.execute(action('localbrowser.click'), context);
assert.equal((clicked.output as { target?: string }).target, 'Continue');
assert.deepEqual(calls, { opened: 1, extracted: 0, snapped: 1, performed: 1, closed: 1 });

const searched = await executor.execute(
  action('localbrowser.search', { query: 'Karachi weather today' }),
  context,
);
assert.equal(
  lastStartUrl,
  'https://www.bing.com/search?q=Karachi%20weather%20today',
  'explicit visual browser search should use a headless-friendly results page',
);
assert.equal(
  lastExtractionInstruction,
  '',
  'browser search must request deterministic body text rather than pass prose as a CSS selector',
);
assert.match(
  searched.summary,
  /Completed public web search\. Results:.*result/,
  'search evidence must enter canonical session state so completion can be verified',
);
assert.deepEqual(calls, { opened: 2, extracted: 1, snapped: 1, performed: 1, closed: 2 });

await assert.rejects(
  executor.execute(
    action('localbrowser.extract', {
      url: 'https://example.com',
      instruction: 'read',
      dataLabels: ['secret'],
    }),
    context,
  ),
  /cannot be sent to a remote website/,
);
assert.equal(calls.opened, 2, 'privacy rejection must happen before browser I/O');

const uncertain = createBrowserExecutor({
  provider: () => adapter,
  decide: async () => ({
    operation: 'CLICK',
    index: 1,
    confidence: 0.4,
    source: 'deterministic',
    rationale: 'weak match',
  }),
});
await assert.rejects(
  uncertain.execute(action('localbrowser.click'), context),
  /below the execution threshold/,
);
assert.equal(calls.performed, 1, 'low-confidence target must not execute');
assert.equal(calls.closed, 3, 'owned sessions must close on failure');

await executor.execute(action('localbrowser.open', { url: 'about:blank' }), context);
assert.equal(calls.closed, 3, 'an explicitly opened session stays available during the run');
await executor.closeRunSessions(context.runId, context);
assert.equal(calls.closed, 4, 'run cleanup releases explicitly opened sessions');

console.log(
  'PASS: browser tools use trusted descriptors, protect sensitive destinations, resolve bounded targets, and release sessions.',
);

function action(
  toolId: string,
  overrides: {
    url?: string;
    query?: string;
    instruction?: string;
    dataLabels?: ToolAction['dataLabels'];
  } = {},
): ToolAction {
  return {
    id: 'act_' + Math.random().toString(36).slice(2),
    runId: context.runId,
    stepId: context.stepId!,
    toolId,
    descriptorVersion: '1',
    operation: toolId,
    arguments: {
      goal: 'Click Continue',
      ...(overrides.url ? { url: overrides.url } : {}),
      ...(overrides.query ? { query: overrides.query } : {}),
      ...(overrides.instruction ? { instruction: overrides.instruction } : {}),
    },
    destination: 'local://chromium',
    dataLabels: overrides.dataLabels ?? ['public'],
    createdAt: new Date().toISOString(),
  };
}

function meta(op: string) {
  return {
    provider: 'localbrowser' as const,
    op,
    mode: 'live' as const,
    latencyMs: 0,
    destination: 'local://chromium',
  };
}

function failure(message: string) {
  return { code: 'BAD_INPUT' as const, message, retryable: false };
}
