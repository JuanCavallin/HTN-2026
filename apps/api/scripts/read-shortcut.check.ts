import assert from 'node:assert/strict';
import type { StoredEvent, ToolDescriptor } from '@htn/shared';
import { verifiedReadShortcut } from '../src/core/tools/readShortcut.js';

const weather: ToolDescriptor = {
  id: 'weather.forecast',
  version: '1',
  providerId: 'weather',
  family: 'weather',
  description: 'Structured forecast',
  capabilities: ['weather.forecast'],
  inputSchemaRef: 'test://weather',
  transport: 'http',
  baselineEffect: 'read',
  reversibility: 'reversible',
  requiredScopes: [],
  allowedDataLabels: ['public'],
  availability: 'available',
  executorRef: 'test://weather',
};

const succeeded = event(true);
const shortcut = verifiedReadShortcut([succeeded], 'step_weather', new Set(['weather.forecast']), [
  weather,
]);
assert.equal(shortcut?.result, 'Verified Karachi forecast at 17:00 and 22:00.');
assert.equal(shortcut?.toolCalls[0]?.tool, 'weather.forecast');

assert.equal(
  verifiedReadShortcut([event(false)], 'step_weather', new Set(['weather.forecast']), [weather]),
  null,
  'an executor that did not verify its evidence must not skip synthesis',
);

const email = { ...weather, id: 'gmail.fetch_emails', family: 'gmail' };
assert.equal(
  verifiedReadShortcut([succeeded], 'step_weather', new Set(['gmail.fetch_emails']), [email]),
  null,
  'large record reads stay on the synthesis path',
);

console.log('PASS: verified structured weather can finish without a redundant model turn.');

function event(outputVerified: boolean): StoredEvent {
  const at = new Date().toISOString();
  return {
    seq: 1,
    runId: 'run_weather',
    at,
    event: {
      type: 'tool.lifecycle',
      lifecycle: {
        id: 'tool_evt_weather',
        runId: 'run_weather',
        stepId: 'step_weather',
        sessionStateId: 'ses_weather',
        phase: 'succeeded',
        action: {
          id: 'act_weather',
          runId: 'run_weather',
          stepId: 'step_weather',
          toolId: 'weather.forecast',
          descriptorVersion: '1',
          operation: 'weather.forecast',
          arguments: { location: 'Karachi', times: ['17:00', '22:00'] },
          destination: 'https://open-meteo.com',
          dataLabels: ['public'],
          createdAt: at,
        },
        outputSummary: 'Verified Karachi forecast at 17:00 and 22:00.',
        outputVerified,
        at,
      },
    },
  };
}
