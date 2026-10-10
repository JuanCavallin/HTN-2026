import assert from 'node:assert/strict';
import type { ProviderCallContext, ToolAction } from '@htn/shared';
import { InMemoryToolExecutorRegistry } from '../src/core/tools/executors.js';
import { InMemoryToolRegistry } from '../src/core/tools/registry.js';
import {
  registerWeatherTool,
  weatherArgumentsForTask,
  WEATHER_FORECAST_EXECUTOR_REF,
} from '../src/core/tools/weather.js';
import { createLiveWeather } from '../src/providers/weather/live.js';

const requests: URL[] = [];
const fetchStub = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  requests.push(url);
  if (url.hostname === 'geocoding-api.open-meteo.com') {
    return Response.json({
      results: [
        {
          name: 'Karachi',
          country: 'Pakistan',
          admin1: 'Sindh',
          latitude: 24.8608,
          longitude: 67.0104,
          timezone: 'Asia/Karachi',
        },
      ],
    });
  }
  return Response.json({
    timezone: 'Asia/Karachi',
    hourly_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' },
    hourly: {
      time: ['2026-09-24T17:00', '2026-09-24T22:00'],
      temperature_2m: [31.2, 28.4],
      apparent_temperature: [34.1, 31.0],
      precipitation_probability: [10, 5],
      weather_code: [1, 2],
      wind_speed_10m: [18.2, 12.5],
    },
  });
}) as typeof fetch;

const adapter = createLiveWeather(
  {
    mode: 'live',
    keyVar: 'WEATHER_MODE',
    baseUrl: 'https://api.open-meteo.com',
  },
  fetchStub,
);
const registry = new InMemoryToolRegistry();
const executors = new InMemoryToolExecutorRegistry();
registerWeatherTool(registry, executors, adapter);

assert.deepEqual(
  weatherArgumentsForTask("search google for today's weather in karachi at 5pm and 10 pm"),
  {
    location: 'karachi',
    times: ['17:00', '22:00'],
    temperatureUnit: 'celsius',
  },
);
assert.equal(
  weatherArgumentsForTask('What is the weather in Karachi tomorrow at 5pm?'),
  null,
  'ambiguous relative dates must stay on the general planning path',
);

const registered = await registry.get('weather.forecast');
assert.ok(registered);
assert.deepEqual(registered.descriptor.capabilities, ['weather.forecast']);
assert.equal(registered.wireName, 'weather_forecast');

const executor = executors.resolve(WEATHER_FORECAST_EXECUTOR_REF);
assert.ok(executor);
const context: ProviderCallContext = {
  runId: 'weather_check',
  stepId: 'weather_step',
  policyRule: 'weather-check',
};
const action: ToolAction = {
  id: 'weather_action',
  runId: context.runId,
  stepId: context.stepId!,
  toolId: 'weather.forecast',
  descriptorVersion: '1',
  operation: 'weather.forecast',
  arguments: {
    location: 'Karachi, Pakistan',
    date: '2026-09-24',
    times: ['17:00', '22:00'],
    temperatureUnit: 'celsius',
  },
  destination: 'https://open-meteo.com',
  dataLabels: ['public'],
  createdAt: new Date().toISOString(),
};
const result = await executor.execute(action, context);
assert.equal(result.verified, true);
assert.match(result.summary, /Karachi, Sindh, Pakistan/);
assert.match(result.summary, /17:00: 31\.2°C/);
assert.match(result.summary, /22:00: 28\.4°C/);
assert.match(result.summary, /Source: Open-Meteo/);
assert.equal(requests.length, 2);
assert.equal(requests[0]?.searchParams.get('name'), 'Karachi, Pakistan');
assert.equal(requests[1]?.searchParams.get('timezone'), 'Asia/Karachi');
assert.equal(requests[1]?.searchParams.get('start_date'), '2026-09-24');

console.log(
  'PASS: structured weather resolves a location, selects exact local hours, and returns verified forecast evidence.',
);
