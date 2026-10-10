import type { Capability, WeatherAdapter, WeatherLocation } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveWeather } from './live.js';

const CAPABILITIES: readonly Capability[] = ['weather.forecast'];

export function create(cfg: ProviderConfig): WeatherAdapter {
  return cfg.mode === 'live' ? createLiveWeather(cfg) : createMockWeather(cfg);
}

function createMockWeather(cfg: ProviderConfig): WeatherAdapter {
  const base = mockBase('weather', CAPABILITIES, cfg.mode);
  return {
    ...base,
    async resolveLocation(input, ctx) {
      return mockCall('weather', 'resolveLocation', cfg.mode, ctx, () => mockLocation(input.query));
    },
    async hourlyForecast(input, ctx) {
      return mockCall('weather', 'hourlyForecast', cfg.mode, ctx, () => ({
        date: input.date,
        timezone: input.timezone,
        temperatureUnit: input.temperatureUnit,
        temperatureUnitSymbol:
          input.temperatureUnit === 'fahrenheit' ? ('°F' as const) : ('°C' as const),
        windSpeedUnit: 'km/h',
        hours: input.times.map((time, index) => ({
          time: input.date + 'T' + time,
          temperature: input.temperatureUnit === 'fahrenheit' ? 82 + index : 28 + index,
          apparentTemperature: input.temperatureUnit === 'fahrenheit' ? 84 + index : 29 + index,
          precipitationProbability: 10 + index * 5,
          weatherCode: 1,
          condition: 'Mainly clear',
          windSpeed: 12 + index,
        })),
      }));
    },
  };
}

function mockLocation(query: string): WeatherLocation {
  if (/karachi/i.test(query)) {
    return {
      name: 'Karachi',
      country: 'Pakistan',
      admin1: 'Sindh',
      latitude: 24.8608,
      longitude: 67.0104,
      timezone: 'Asia/Karachi',
    };
  }
  return {
    name: query.trim() || 'Mock location',
    latitude: 0,
    longitude: 0,
    timezone: 'UTC',
  };
}
