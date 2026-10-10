import type {
  ProviderCallContext,
  ProviderResult,
  WeatherAdapter,
  WeatherForecastHour,
  WeatherLocation,
} from '@htn/shared';
import type { ProviderConfig } from '../../config.js';

const GEOCODING_BASE_URL = 'https://geocoding-api.open-meteo.com';
const REQUEST_TIMEOUT_MS = 8_000;

interface GeocodingResponse {
  results?: Array<{
    name?: unknown;
    country?: unknown;
    admin1?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    timezone?: unknown;
  }>;
}

interface ForecastResponse {
  timezone?: unknown;
  hourly_units?: {
    temperature_2m?: unknown;
    wind_speed_10m?: unknown;
  };
  hourly?: {
    time?: unknown;
    temperature_2m?: unknown;
    apparent_temperature?: unknown;
    precipitation_probability?: unknown;
    weather_code?: unknown;
    wind_speed_10m?: unknown;
  };
}

export function createLiveWeather(
  cfg: ProviderConfig,
  fetchImpl: typeof fetch = fetch,
): WeatherAdapter {
  const forecastBaseUrl = (cfg.baseUrl ?? 'https://api.open-meteo.com').replace(/\/$/, '');

  return {
    id: 'weather',
    mode: 'live',
    capabilities: ['weather.forecast'],

    async health() {
      return success(
        'health',
        0,
        { detail: 'Open-Meteo geocoding and hourly forecast' },
        forecastBaseUrl,
      );
    },

    async invoke<TIn, TOut>(op: string, _input: TIn, _ctx: ProviderCallContext) {
      return failure<TOut>(
        op,
        0,
        'BAD_INPUT',
        'No generic weather operation is available.',
        false,
        forecastBaseUrl,
      );
    },

    async resolveLocation(input, ctx) {
      const started = Date.now();
      const query = input.query.trim();
      if (!query) {
        return failure(
          'resolveLocation',
          started,
          'BAD_INPUT',
          'Weather location is required.',
          false,
          GEOCODING_BASE_URL,
        );
      }
      try {
        const url = new URL('/v1/search', GEOCODING_BASE_URL);
        url.searchParams.set('name', query);
        url.searchParams.set('count', '5');
        url.searchParams.set('language', 'en');
        url.searchParams.set('format', 'json');
        const response = await fetchImpl(url, { signal: requestSignal(ctx.signal) });
        if (!response.ok) throw new Error('Geocoding returned HTTP ' + response.status.toString());
        const payload = (await response.json()) as GeocodingResponse;
        const candidates = (payload.results ?? []).flatMap((candidate) => {
          if (
            typeof candidate.name !== 'string' ||
            typeof candidate.latitude !== 'number' ||
            typeof candidate.longitude !== 'number' ||
            typeof candidate.timezone !== 'string'
          ) {
            return [];
          }
          return [
            {
              name: candidate.name,
              ...(typeof candidate.country === 'string' ? { country: candidate.country } : {}),
              ...(typeof candidate.admin1 === 'string' ? { admin1: candidate.admin1 } : {}),
              latitude: candidate.latitude,
              longitude: candidate.longitude,
              timezone: candidate.timezone,
            } satisfies WeatherLocation,
          ];
        });
        if (candidates.length === 0) {
          return failure(
            'resolveLocation',
            started,
            'BAD_INPUT',
            'No weather location matched "' + query + '".',
            false,
            GEOCODING_BASE_URL,
          );
        }
        return success('resolveLocation', started, candidates[0]!, GEOCODING_BASE_URL);
      } catch (error) {
        return failure(
          'resolveLocation',
          started,
          isAbort(error) ? 'TIMEOUT' : 'UPSTREAM',
          errorMessage(error),
          true,
          GEOCODING_BASE_URL,
        );
      }
    },

    async hourlyForecast(input, ctx) {
      const started = Date.now();
      try {
        const url = new URL('/v1/forecast', forecastBaseUrl);
        url.searchParams.set('latitude', input.latitude.toString());
        url.searchParams.set('longitude', input.longitude.toString());
        url.searchParams.set(
          'hourly',
          [
            'temperature_2m',
            'apparent_temperature',
            'precipitation_probability',
            'weather_code',
            'wind_speed_10m',
          ].join(','),
        );
        url.searchParams.set('timezone', input.timezone);
        url.searchParams.set('start_date', input.date);
        url.searchParams.set('end_date', input.date);
        url.searchParams.set('temperature_unit', input.temperatureUnit);
        const response = await fetchImpl(url, { signal: requestSignal(ctx.signal) });
        if (!response.ok) throw new Error('Forecast returned HTTP ' + response.status.toString());
        const payload = (await response.json()) as ForecastResponse;
        const hourly = payload.hourly;
        const times = stringArray(hourly?.time);
        const temperatures = numberArray(hourly?.temperature_2m);
        const apparent = numberArray(hourly?.apparent_temperature);
        const precipitation = numberArray(hourly?.precipitation_probability);
        const codes = numberArray(hourly?.weather_code);
        const wind = numberArray(hourly?.wind_speed_10m);
        if (
          times.length === 0 ||
          [temperatures, apparent, precipitation, codes, wind].some(
            (values) => values.length !== times.length,
          )
        ) {
          throw new Error('Forecast response contained incomplete hourly arrays.');
        }

        const requested = new Set(input.times.map((time) => input.date + 'T' + time));
        const hours: WeatherForecastHour[] = times.flatMap((time, index) => {
          if (!requested.has(time)) return [];
          const weatherCode = codes[index]!;
          return [
            {
              time,
              temperature: temperatures[index]!,
              apparentTemperature: apparent[index]!,
              precipitationProbability: precipitation[index]!,
              weatherCode,
              condition: conditionFor(weatherCode),
              windSpeed: wind[index]!,
            },
          ];
        });
        if (hours.length !== requested.size) {
          const found = new Set(hours.map((hour) => hour.time.slice(-5)));
          const missing = input.times.filter((time) => !found.has(time));
          return failure(
            'hourlyForecast',
            started,
            'BAD_INPUT',
            'Hourly forecast did not contain requested local time(s): ' + missing.join(', '),
            false,
            forecastBaseUrl,
          );
        }

        return success(
          'hourlyForecast',
          started,
          {
            date: input.date,
            timezone: typeof payload.timezone === 'string' ? payload.timezone : input.timezone,
            temperatureUnit: input.temperatureUnit,
            temperatureUnitSymbol:
              payload.hourly_units?.temperature_2m === '°F' ? ('°F' as const) : ('°C' as const),
            windSpeedUnit:
              typeof payload.hourly_units?.wind_speed_10m === 'string'
                ? payload.hourly_units.wind_speed_10m
                : 'km/h',
            hours,
          },
          forecastBaseUrl,
        );
      } catch (error) {
        return failure(
          'hourlyForecast',
          started,
          isAbort(error) ? 'TIMEOUT' : 'UPSTREAM',
          errorMessage(error),
          true,
          forecastBaseUrl,
        );
      }
    },
  };
}

function success<T>(op: string, started: number, data: T, destination: string): ProviderResult<T> {
  return {
    ok: true,
    data,
    meta: {
      provider: 'weather',
      op,
      mode: 'live',
      latencyMs: Math.max(0, Date.now() - started),
      destination,
    },
  };
}

function failure<T>(
  op: string,
  started: number,
  code: 'BAD_INPUT' | 'TIMEOUT' | 'UPSTREAM',
  message: string,
  retryable: boolean,
  destination: string,
): ProviderResult<T> {
  return {
    ok: false,
    error: { code, message, retryable },
    meta: {
      provider: 'weather',
      op,
      mode: 'live',
      latencyMs: Math.max(0, Date.now() - started),
      destination,
    },
  };
}

function requestSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number') ? value : [];
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function conditionFor(code: number): string {
  if (code === 0) return 'Clear sky';
  if (code === 1) return 'Mainly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if ([45, 48].includes(code)) return 'Fog';
  if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle';
  if ([61, 63, 65, 66, 67].includes(code)) return 'Rain';
  if ([71, 73, 75, 77].includes(code)) return 'Snow';
  if ([80, 81, 82].includes(code)) return 'Rain showers';
  if ([85, 86].includes(code)) return 'Snow showers';
  if ([95, 96, 99].includes(code)) return 'Thunderstorm';
  return 'Unknown conditions';
}
