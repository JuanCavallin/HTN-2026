import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const root = 'http://localhost:5173';
const output = process.env.SCREENSHOT_DIR;
const errors = [];
const passed = [];

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  page.on('pageerror', (error) => errors.push(error.message));
  let apiCalls = 0;
  await page.route('**/api/**', async (route) => {
    apiCalls++;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'OFFLINE_TEST', message: 'Test backend is offline' } }) });
  });
  await page.goto(root);
  await page.getByRole('button', { name: 'Pause workflow', exact: true }).click();
  const clock = await page.locator('.elapsed-time').innerText();
  await page.waitForTimeout(450);
  assert.equal(await page.locator('.elapsed-time').innerText(), clock);
  assert.equal(apiCalls, 0);
  await page.getByRole('button', { name: /Read account context, running/ }).click();
  await page.getByRole('heading', { name: 'Decision detail' }).waitFor();
  await page.getByRole('button', { name: 'Close decision detail' }).click();
  if (output) await page.screenshot({ path: resolve(output, 'desktop.png'), fullPage: true });
  passed.push('Preview pauses its clock, makes no API calls, and supports node inspection');
  await page.getByRole('button', { name: 'Resume workflow', exact: true }).click();
  await page.waitForTimeout(450);
  assert.notEqual(await page.locator('.elapsed-time').innerText(), clock);
  await page.getByRole('button', { name: 'Pause workflow', exact: true }).click();
  passed.push('Resume restarts preview progression');

  await page.getByRole('button', { name: 'Connect harness', exact: true }).click();
  await page.getByRole('button', { name: 'Connect Hermes', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not reach the Zephyr API' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  passed.push('Harness failure is explicit and Escape closes the connection dialog');

  await page.goto(root + '/?new=1');
  await page.getByRole('heading', { name: /Big tasks/ }).waitFor();
  await page.getByRole('textbox', { name: 'Message Zephyr' }).fill('My own task');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('This is the sample workflow, not a generated answer', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Pause workflow', exact: true }).click();
  passed.push('Custom preview messages are not passed off as generated answers');

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  mobile.on('pageerror', (error) => errors.push(error.message));
  await mobile.route('**/api/**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await mobile.goto(root + '/?example=trip');
  await mobile.getByRole('button', { name: 'Pause workflow', exact: true }).click();
  assert.equal(await mobile.getByRole('tab', { name: 'Activity', exact: true }).getAttribute('aria-selected'), 'true');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  if (output) await mobile.screenshot({ path: resolve(output, 'mobile.png'), fullPage: true });
  await mobile.getByRole('button', { name: 'Toggle navigation' }).click();
  await mobile.getByRole('button', { name: 'Close navigation', exact: true }).first().click();
  passed.push('Mobile keeps readable activity, working navigation, and no horizontal page overflow');

  const live = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  live.on('pageerror', (error) => errors.push(error.message));
  const stamp = '2026-09-19T12:00:00.000Z';
  const graph = { id: 'g-test', name: 'Test graph', version: 1, nodes: [{ id: 'n1', type: 'agent_task', label: 'Browser test task', position: { x: 0, y: 0 }, config: { goal: 'Test', availableTools: [] } }], edges: [], createdAt: stamp, updatedAt: stamp };
  const run = { id: 'r-test', title: 'Browser integration test', kind: 'graph', status: 'succeeded', input: { graphId: graph.id, graphSnapshot: graph }, createdAt: stamp, updatedAt: stamp, summary: 'Mocked integration result.' };
  const step = { id: 's1', runId: run.id, nodeId: 'n1', seq: 1, parentStepId: null, kind: 'agent_task', label: 'Browser test task', status: 'succeeded', startedAt: stamp, endedAt: '2026-09-19T12:00:02.000Z', providerId: 'hermes' };
  const ledger = { id: 'e1', runId: run.id, stepId: 's1', destination: 'mock://hermes', tokensIn: 100, tokensOut: 25, estimatedCostCents: 2.5, latencyMs: 1000, decision: 'allowed', policyRule: 'test', dataSpans: [], at: stamp };
  const conversation = { id: 'c-test', title: 'Test', messages: [{ id: 'm1', role: 'user', text: 'Run a mocked task', at: stamp }], createdAt: stamp, updatedAt: stamp };
  const calls = [];
  await live.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(route.request().method() + ' ' + path);
    if (path.endsWith('/stream')) {
      const events = [{ type: 'step.upserted', step }, { type: 'egress.logged', egress: ledger }, { type: 'run.updated', run }];
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map((event, index) => `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n\n`).join('') });
    }
    const value = path === '/api/providers' ? { providers: [{ id: 'hermes', mode: 'mock', healthy: true, capabilities: ['agent.runtime'] }], bindings: { 'agent.runtime': 'hermes' } }
      : path === '/api/conversations' ? { conversation }
      : path.endsWith('/messages') ? { conversation, message: { text: 'Prepared.' }, graph, delegation: {} }
      : path === '/api/runs' ? { run }
      : path === '/api/runs/r-test' ? { run, steps: [step], egress: [ledger], approvals: [], piiSpans: [] }
      : { graph };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  });
  await live.goto(root + '/?new=1');
  await live.getByRole('button', { name: 'Connect harness', exact: true }).click();
  await live.getByRole('button', { name: 'Connect Hermes', exact: true }).click();
  await live.getByText('The backend is using mock Hermes.', { exact: false }).waitFor();
  await live.getByRole('button', { name: 'Close harness connection' }).click();
  await live.getByRole('combobox', { name: 'Execution mode' }).selectOption('backend');
  await live.getByRole('textbox', { name: 'Message Zephyr' }).fill('Run a mocked task');
  await live.getByRole('button', { name: 'Send message', exact: true }).click();
  await live.waitForURL('**/runs/r-test');
  await live.locator('.completion-line').filter({ hasText: 'Run complete' }).waitFor();
  assert.ok(calls.includes('POST /api/conversations'));
  assert.ok(calls.includes('POST /api/conversations/c-test/messages'));
  assert.ok(calls.includes('POST /api/runs'));
  assert.match(await live.locator('.run-metrics').innerText(), /125/);
  assert.match(await live.locator('.run-metrics').innerText(), /\$0\.025/);
  assert.equal(await live.getByRole('button', { name: 'Pause unavailable', exact: true }).isDisabled(), true);
  assert.match(await live.locator('.run-status').innerText(), /mock/);
  passed.push('Mocked HTTP/SSE integration launches immediately, renders actual event values, preserves mock labels, and disables unsupported live pause');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed, pageErrors: errors }, null, 2));
} finally {
  await browser.close();
}
