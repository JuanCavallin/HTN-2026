import type { Json, ProviderCallContext, ToolDescriptor, WeatherAdapter } from '@htn/shared';
import type { InMemoryToolExecutorRegistry, ToolExecutionOutput } from './executors.js';
import type { InMemoryToolRegistry } from './registry.js';

export const WEATHER_FORECAST_TOOL_ID = 'weather.forecast';
export const WEATHER_FORECAST_EXECUTOR_REF = 'provider://weather.forecast';
const WEATHER_SERVICE_DESTINATION = 'https://open-meteo.com';

const descriptor: ToolDescriptor = {
  id: WEATHER_FORECAST_TOOL_ID,
  version: '1',
  providerId: 'weather',
  family: 'weather',
  description:
    'Get a structured hourly weather forecast for a named location at exact local hours. Prefer this over browser search for weather, temperature, rain, or forecast questions.',
  capabilities: ['weather.forecast'],
  aliases: [
    'current weather',
    'hourly forecast',
    'rain forecast',
    'temperature forecast',
    'weather forecast',
  ],
  inputSchemaRef: 'agentos://schemas/weather.forecast/1',
  transport: 'http',
  baselineEffect: 'read',
  reversibility: 'reversible',
  requiredScopes: [],
  allowedDataLabels: ['public', 'private'],
  availability: 'available',
  executorRef: WEATHER_FORECAST_EXECUTOR_REF,
};

/**
 * Deterministic argument planning for the common exact-hour weather request.
 * This intentionally handles only unambiguous inputs; anything else stays on
 * the general harness path instead of guessing a city, date, or time.
 */
export function weatherArgumentsForTask(task: string): Record<string, Json> | null {
  if (/\btomorrow\b/i.test(task)) return null;
  const location = task.match(
    /\b(?:weather|forecast|temperature)(?:\s+forecast)?\s+(?:in|for)\s+([\p{L}][\p{L} .'-]*?)(?=\s+(?:at|on)\b|[,?;]|$)/iu,
  )?.[1];
  if (!location?.trim()) return null;

  const times: string[] = [];
  for (const match of task.matchAll(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/gi)) {
    const minute = match[2] ?? '00';
    if (minute !== '00') return null;
    let hour = Number(match[1]) % 12;
    if (match[3]?.toLowerCase() === 'pm') hour += 12;
    times.push(hour.toString().padStart(2, '0') + ':00');
  }
  const uniqueTimes = [...new Set(times)];
  if (uniqueTimes.length === 0) return null;

  const explicitDate = task.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  return {
    location: location.trim(),
    times: uniqueTimes,
    ...(explicitDate ? { date: explicitDate } : {}),
    temperatureUnit: /\b(?:fahrenheit|degrees?\s*f)\b/i.test(task) ? 'fahrenheit' : 'celsius',
  };
}

export function registerWeatherTool(
  registry: InMemoryToolRegistry,
  executors: InMemoryToolExecutorRegistry,
  adapter: WeatherAdapter,
): void {
  registry.register({
    descriptor,
    wireName: 'weather_forecast',
    inputSchema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          minLength: 2,
          description: 'City or place name, optionally followed by country or region.',
        },
        date: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description:
            'Local calendar date in YYYY-MM-DD. Omit when the user says today; the tool resolves today in the location timezone.',
        },
        times: {
          type: 'array',
          minItems: 1,
          maxItems: 24,
          uniqueItems: true,
          items: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):00$' },
          description: 'Requested local hours in 24-hour HH:00 form, such as 17:00 and 22:00.',
        },
        temperatureUnit: {
          type: 'string',
          enum: ['celsius', 'fahrenheit'],
          description: 'Defaults to celsius.',
        },
      },
      required: ['location', 'times'],
      additionalProperties: false,
    },
  });

  executors.register({
    ref: WEATHER_FORECAST_EXECUTOR_REF,
    destinationFor: () => WEATHER_SERVICE_DESTINATION,
    async execute(action, ctx): Promise<ToolExecutionOutput> {
      const args = objectArgs(action.arguments);
      const locationQuery = requiredString(args, 'location');
      const times = requiredHours(args, 'times');
      const requestedDate = optionalString(args, 'date');
      if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        throw new Error('Weather date must use YYYY-MM-DD.');
      }
      const temperatureUnit = optionalString(args, 'temperatureUnit') ?? 'celsius';
      if (!['celsius', 'fahrenheit'].includes(temperatureUnit)) {
        throw new Error('Weather temperatureUnit must be celsius or fahrenheit.');
      }

      const location = await adapter.resolveLocation(
        { query: locationQuery },
        childContext(ctx, 'weather-location-resolution'),
      );
      if (!location.ok) throw new Error(location.error.message);
      const date = requestedDate ?? dateInTimezone(new Date(), location.data.timezone);
      const forecast = await adapter.hourlyForecast(
        {
          latitude: location.data.latitude,
          longitude: location.data.longitude,
          timezone: location.data.timezone,
          date,
          times,
          temperatureUnit: temperatureUnit as 'celsius' | 'fahrenheit',
        },
        childContext(ctx, 'weather-hourly-forecast'),
      );
      if (!forecast.ok) throw new Error(forecast.error.message);

      const place = [location.data.name, location.data.admin1, location.data.country]
        .filter(Boolean)
        .join(', ');
      const detail = forecast.data.hours
        .map(
          (hour) =>
            hour.time.slice(-5) +
            ': ' +
            hour.temperature.toString() +
            forecast.data.temperatureUnitSymbol +
            ', feels like ' +
            hour.apparentTemperature.toString() +
            forecast.data.temperatureUnitSymbol +
            ', ' +
            hour.condition.toLowerCase() +
            ', precipitation ' +
            hour.precipitationProbability.toString() +
            '%, wind ' +
            hour.windSpeed.toString() +
            ' ' +
            forecast.data.windSpeedUnit,
        )
        .join('; ');
      const summary =
        'Verified hourly forecast for ' +
        place +
        ' on ' +
        date +
        ' (' +
        forecast.data.timezone +
        '): ' +
        detail +
        '. Source: Open-Meteo.';

      return {
        output: {
          location: location.data,
          ...forecast.data,
          source: 'Open-Meteo',
        } as unknown as Json,
        summary,
        sanitizedSummary: summary,
        dataLabels: [...action.dataLabels],
        verified: true,
      };
    },
  });
}

function objectArgs(value: Json): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Weather tool arguments must be an object.');
  }
  return value;
}

function requiredString(value: Record<string, Json>, key: string): string {
  const result = optionalString(value, key);
  if (!result) throw new Error('Weather argument "' + key + '" is required.');
  return result;
}

function optionalString(value: Record<string, Json>, key: string): string | undefined {
  const item = value[key];
  return typeof item === 'string' && item.trim() ? item.trim() : undefined;
}

function requiredHours(value: Record<string, Json>, key: string): string[] {
  const item = value[key];
  if (!Array.isArray(item) || item.length === 0 || item.length > 24) {
    throw new Error('Weather argument "times" must contain 1-24 local hours.');
  }
  const hours = item.flatMap((entry) =>
    typeof entry === 'string' && /^(?:[01]\d|2[0-3]):00$/.test(entry) ? [entry] : [],
  );
  if (hours.length !== item.length || new Set(hours).size !== hours.length) {
    throw new Error('Weather times must be unique 24-hour values such as 17:00.');
  }
  return hours;
}

function dateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new Error('Could not resolve local weather date.');
  return year + '-' + month + '-' + day;
}

function childContext(ctx: ProviderCallContext, policyRule: string): ProviderCallContext {
  return { ...ctx, policyRule };
}
