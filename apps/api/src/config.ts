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
const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().url().optional(),
);

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
  // Hermes is driven as a local subprocess over ACP (`uv run hermes-acp`), not
  // an HTTP API — there is no bearer key. What live mode actually needs is the
  // absolute path to a `hermes-agent` checkout with the `acp` extra installed.
  HERMES_CWD: z.string().optional(),
  HERMES_API_KEY: z.string().optional(),
  HERMES_BASE_URL: z.string().optional(),

  AI_GATEWAY_API_KEY: z.string().optional(),
  AI_GATEWAY_BASE_URL: optionalUrl,
  JEV_MODE: modeEnum.default('mock'),
  /** Legacy aliases retained so existing local setups keep working. */
  JEV_API_KEY: z.string().optional(),
  JEV_BASE_URL: optionalUrl,

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
  /** Absolute path to a local checkout the provider drives as a subprocess (Hermes only). */
  cwd?: string;
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

/** Hermes gates on HERMES_CWD (a local subprocess needs a checkout, not a key). */
function resolveHermes(): ProviderConfig {
  let mode: ProviderMode = env.HERMES_MODE;
  if (env.MOCK_ALL) mode = 'mock';
  else if (mode === 'live' && !env.HERMES_CWD) mode = 'mock';
  return { mode, cwd: env.HERMES_CWD, baseUrl: env.HERMES_BASE_URL, keyVar: 'HERMES_CWD' };
}

const providers: Record<ProviderId, ProviderConfig> = {
  hermes: resolveHermes(),
  jev: resolve(
    env.JEV_MODE,
    env.AI_GATEWAY_API_KEY ?? env.JEV_API_KEY,
    env.AI_GATEWAY_API_KEY ? 'AI_GATEWAY_API_KEY' : 'JEV_API_KEY',
    { baseUrl: env.AI_GATEWAY_BASE_URL ?? env.JEV_BASE_URL },
  ),
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
