/**
 * Environment -> a frozen, validated config object.
 *
 * Loaded by tsx via --env-file-if-exists=../../.env (Node 22 native; no dotenv dep).
 *
 * THE ONE INVARIANT: a fresh clone with no .env and no API keys must boot and run
 * the full demo. A missing key downgrades live -> mock. It never throws.
 */

import { z } from 'zod';
import { PROVIDER_IDS, type ProviderId, type ProviderMode } from '@htn/shared';

const modeEnum = z.enum(['mock', 'live', 'disabled']);

/** Accepts 1/true/yes/on, case-insensitive; anything else is false. */
const boolish = z
  .string()
  .optional()
  .transform((v) => /^(1|true|yes|on)$/i.test(v ?? ''));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),

  MOCK_ALL: boolish,
  PERSIST_TO_DISK: boolish,
  MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  MOCK_MIN_LATENCY_MS: z.coerce.number().int().min(0).default(250),
  MOCK_MAX_LATENCY_MS: z.coerce.number().int().min(0).default(900),

  HERMES_MODE: modeEnum.default('mock'),
  HERMES_API_KEY: z.string().optional(),
  HERMES_BASE_URL: z.string().optional(),

  JEV_MODE: modeEnum.default('mock'),
  JEV_API_KEY: z.string().optional(),
  JEV_BASE_URL: z.string().optional(),

  BROWSERBASE_MODE: modeEnum.default('mock'),
  BROWSERBASE_API_KEY: z.string().optional(),
  BROWSERBASE_PROJECT_ID: z.string().optional(),

  COMPOSIO_MODE: modeEnum.default('mock'),
  COMPOSIO_API_KEY: z.string().optional(),

  ANTHROPIC_MODE: modeEnum.default('mock'),
  ANTHROPIC_API_KEY: z.string().optional(),

  GPTZERO_MODE: modeEnum.default('disabled'),
  GPTZERO_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[config] Invalid environment:');
  for (const issue of parsed.error.issues) {
    console.error('  - ' + issue.path.join('.') + ': ' + issue.message);
  }
  process.exit(1);
}

const env = parsed.data;

export interface ProviderConfig {
  mode: ProviderMode;
  apiKey?: string;
  baseUrl?: string;
  projectId?: string;
  /** Name of the env var that would enable live mode. Shown in health detail. */
  keyVar: string;
}

/**
 * Resolve a provider's effective mode.
 * - MOCK_ALL forces mock (the demo-day wifi insurance switch).
 * - live without a key silently downgrades to mock rather than crashing.
 */
function resolve(
  requested: ProviderMode,
  apiKey: string | undefined,
  keyVar: string,
  extra: Partial<ProviderConfig> = {},
): ProviderConfig {
  let mode: ProviderMode = requested;
  if (env.MOCK_ALL) mode = 'mock';
  else if (requested === 'live' && !apiKey) mode = 'mock';
  return { mode, apiKey, keyVar, ...extra };
}

const providers: Record<ProviderId, ProviderConfig> = {
  hermes: resolve(env.HERMES_MODE, env.HERMES_API_KEY, 'HERMES_API_KEY', {
    baseUrl: env.HERMES_BASE_URL,
  }),
  jev: resolve(env.JEV_MODE, env.JEV_API_KEY, 'JEV_API_KEY', { baseUrl: env.JEV_BASE_URL }),
  browserbase: resolve(env.BROWSERBASE_MODE, env.BROWSERBASE_API_KEY, 'BROWSERBASE_API_KEY', {
    projectId: env.BROWSERBASE_PROJECT_ID,
  }),
  composio: resolve(env.COMPOSIO_MODE, env.COMPOSIO_API_KEY, 'COMPOSIO_API_KEY'),
  anthropic: resolve(env.ANTHROPIC_MODE, env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY'),
  gptzero: resolve(env.GPTZERO_MODE, env.GPTZERO_API_KEY, 'GPTZERO_API_KEY'),
};

export const config = Object.freeze({
  env: env.NODE_ENV,
  isDev: env.NODE_ENV === 'development',
  port: env.PORT,
  webOrigin: env.WEB_ORIGIN,
  persistToDisk: env.PERSIST_TO_DISK,
  mock: {
    all: env.MOCK_ALL,
    failureRate: env.MOCK_FAILURE_RATE,
    minLatencyMs: env.MOCK_MIN_LATENCY_MS,
    maxLatencyMs: Math.max(env.MOCK_MIN_LATENCY_MS, env.MOCK_MAX_LATENCY_MS),
  },
  providers,
});

export function logConfigSummary(): void {
  const summary = PROVIDER_IDS.map((id) => id + '=' + providers[id].mode).join('  ');
  console.log('[config] port=' + config.port + '  mockAll=' + config.mock.all);
  console.log('[config] providers: ' + summary);
}
