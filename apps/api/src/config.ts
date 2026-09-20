/**
 * Environment -> a frozen, validated config object.
 *
 * Loaded by tsx via --env-file-if-exists=../../.env (Node 22 native; no dotenv dep).
 *
 * THE ONE INVARIANT: a fresh clone with no .env and no API keys must boot and run
 * the full demo. A missing key downgrades live -> mock. It never throws.
 */

import { existsSync } from 'node:fs';
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
  SQLITE_PATH: z.string().default('../../.data/agentos.sqlite'),
  MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  MOCK_MIN_LATENCY_MS: z.coerce.number().int().min(0).default(250),
  MOCK_MAX_LATENCY_MS: z.coerce.number().int().min(0).default(900),

  HERMES_MODE: modeEnum.default('mock'),
  // Hermes is driven as a local subprocess over ACP (`uv run hermes-acp`), not
  // an HTTP API — there is no bearer key. What live mode actually needs is the
  // absolute path to a `hermes-agent` checkout with the `acp` and `mcp` extras installed.
  HERMES_CWD: z.string().optional(),
  HERMES_PROFILE_DIR: z.string().optional(),
  HERMES_API_KEY: z.string().optional(),
  // optionalUrl, not z.string(): `.env.example` ships `HERMES_BASE_URL=`, and an empty
  // string would otherwise defeat the `??` fallback to the model gateway below.
  HERMES_BASE_URL: optionalUrl,

  MODEL_GATEWAY_BASE_URL: optionalUrl,
  MODEL_GATEWAY_API_KEY: z.string().default('agentos-local'),
  MCP_GATEWAY_URL: optionalUrl,
  MCP_GATEWAY_API_KEY: z.string().default('agentos-mcp-local'),

  AI_GATEWAY_API_KEY: z.string().optional(),
  AI_GATEWAY_BASE_URL: optionalUrl,
  JEV_MODE: modeEnum.default('mock'),
  /** Legacy aliases retained so existing local setups keep working. */
  JEV_API_KEY: z.string().optional(),
  JEV_BASE_URL: optionalUrl,

  BROWSERBASE_MODE: modeEnum.default('mock'),
  BROWSERBASE_API_KEY: z.string().optional(),
  BROWSERBASE_PROJECT_ID: z.string().optional(),
  LOCALBROWSER_MODE: modeEnum.default('mock'),
  LOCALBROWSER_CHANNEL: z.string().optional(),
  BROWSER_MAX_SESSIONS: z.coerce.number().int().positive().default(2),
  BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  BROWSER_DECISION_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  BROWSER_MAX_ELEMENTS: z.coerce.number().int().positive().default(60),
  BROWSER_ACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(4_000),
  BROWSER_SETTLE_MS: z.coerce.number().int().min(0).default(50),
  BROWSER_SETTLE_SELECT_MS: z.coerce.number().int().min(0).default(200),

  COMPOSIO_MODE: modeEnum.default('mock'),
  COMPOSIO_API_KEY: z.string().optional(),
  COMPOSIO_BASE_URL: optionalUrl,
  COMPOSIO_USER_ID: z.string().default('agentos-demo-user'),
  COMPOSIO_AUTH_CONFIG_ID: z.string().optional(),
  COMPOSIO_TOOL_SLUGS: z.string().default('GMAIL_SEND_EMAIL'),
  COMPOSIO_TOOLKITS: z.string().default(''),
  COMPOSIO_DISCOVERY_LIMIT: z.coerce.number().int().min(1).max(100).default(24),

  OPENROUTER_MODE: modeEnum.default('mock'),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: optionalUrl,
  OPENROUTER_CHEAP_MODEL: z.string().default('openai/gpt-5.6-luna'),
  OPENROUTER_FRONTIER_MODEL: z.string().default('openai/gpt-5.6-sol'),

  OLLAMA_MODE: modeEnum.default('mock'),
  OLLAMA_BASE_URL: optionalUrl,
  OLLAMA_MODEL: z.string().default('qwen3:8b'),

  ANTHROPIC_MODE: modeEnum.default('mock'),
  ANTHROPIC_API_KEY: z.string().optional(),

  // A DIRECT Google route, deliberately separate from the OpenRouter catalog.
  // Two distinct cloud vendors is what makes route selection a real decision
  // rather than a label, and it gives the ledger two distinct destinations.
  GEMINI_MODE: modeEnum.default('mock'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_BASE_URL: optionalUrl,
  GEMINI_CHEAP_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_FRONTIER_MODEL: z.string().default('gemini-3.8-flash'),

  // Observability. Entirely inert without SENTRY_DSN: the no-key clone must
  // still boot and run the full demo, so this may never become required.
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
  SENTRY_RELEASE: z.string().optional(),

  // Mock by default so a keyless clone still exercises the outbound-text check
  // end to end; GPTZERO_API_KEY plus GPTZERO_MODE=live scores for real.
  GPTZERO_MODE: modeEnum.default('mock'),
  GPTZERO_API_KEY: z.string().optional(),
  GPTZERO_BASE_URL: optionalUrl,
  /** P(ai) at or above which an authorized outbound send stops for a human. */
  GPTZERO_ESCALATION_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
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
  /** Installed Playwright browser channel (local browser only). */
  channel?: string;
  /** Isolated provider profile directory (Hermes only). */
  profileDir?: string;
  /** AgentOS-owned MCP endpoint injected into the isolated Hermes profile. */
  mcpUrl?: string;
  /** Local bearer credential passed to Hermes by environment reference. */
  mcpApiKey?: string;
  /** Stable application user used to isolate third-party OAuth connections. */
  userId?: string;
  /** Composio auth config selected by the application, never by the model. */
  authConfigId?: string;
  /** Provider-native tool slugs explicitly reviewed by AgentOS. */
  toolSlugs?: string[];
  /** Optional provider toolkit filter used for task-time catalog discovery. */
  toolkits?: string[];
  /** Maximum catalog candidates fetched before local policy and Jev filtering. */
  discoveryLimit?: number;
  /** Explicit model allowlist exposed to Jev. */
  models?: { cheap: string; frontier: string };
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
  else if (mode === 'live' && !existsSync(env.HERMES_CWD!)) {
    // A shared .env carries a teammate's absolute path. A checkout that is not on
    // THIS machine is the same situation as a missing key: downgrade, never crash.
    console.warn('[config] HERMES_CWD does not exist on this machine; hermes -> mock');
    mode = 'mock';
  }
  return {
    mode,
    cwd: env.HERMES_CWD,
    profileDir: env.HERMES_PROFILE_DIR,
    baseUrl: env.HERMES_BASE_URL ?? env.MODEL_GATEWAY_BASE_URL ?? `http://127.0.0.1:${env.PORT}/v1`,
    apiKey: env.MODEL_GATEWAY_API_KEY,
    mcpUrl: env.MCP_GATEWAY_URL ?? `http://127.0.0.1:${env.PORT}/mcp`,
    mcpApiKey: env.MCP_GATEWAY_API_KEY,
    keyVar: 'HERMES_CWD',
  };
}

/** Local HTTP providers need no secret, so live mode is gated only by MOCK_ALL. */
function resolveLocal(
  requested: ProviderMode,
  keyVar: string,
  extra: Partial<ProviderConfig>,
): ProviderConfig {
  return {
    mode: env.MOCK_ALL ? 'mock' : requested,
    keyVar,
    ...extra,
  };
}

function resolveLocalBrowser(): ProviderConfig {
  let mode: ProviderMode = env.LOCALBROWSER_MODE;
  if (env.MOCK_ALL) mode = 'mock';
  else if (mode === 'live' && !env.LOCALBROWSER_CHANNEL) mode = 'mock';
  return { mode, channel: env.LOCALBROWSER_CHANNEL, keyVar: 'LOCALBROWSER_CHANNEL' };
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
  localbrowser: resolveLocalBrowser(),
  composio: resolve(env.COMPOSIO_MODE, env.COMPOSIO_API_KEY, 'COMPOSIO_API_KEY', {
    baseUrl: env.COMPOSIO_BASE_URL ?? 'https://backend.composio.dev',
    userId: env.COMPOSIO_USER_ID,
    authConfigId: env.COMPOSIO_AUTH_CONFIG_ID,
    toolSlugs: env.COMPOSIO_TOOL_SLUGS.split(',')
      .map((slug) => slug.trim())
      .filter(Boolean),
    toolkits: env.COMPOSIO_TOOLKITS.split(',')
      .map((toolkit) => toolkit.trim().toLowerCase())
      .filter(Boolean),
    discoveryLimit: env.COMPOSIO_DISCOVERY_LIMIT,
  }),
  openrouter: resolve(env.OPENROUTER_MODE, env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY', {
    baseUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    models: {
      cheap: env.OPENROUTER_CHEAP_MODEL,
      frontier: env.OPENROUTER_FRONTIER_MODEL,
    },
  }),
  ollama: resolveLocal(env.OLLAMA_MODE, 'OLLAMA_BASE_URL', {
    baseUrl: env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    models: { cheap: env.OLLAMA_MODEL, frontier: env.OLLAMA_MODEL },
  }),
  mcp: resolveLocal('live', 'MCP_CONNECTIONS', {}),
  anthropic: resolve(env.ANTHROPIC_MODE, env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY'),
  gemini: resolve(env.GEMINI_MODE, env.GEMINI_API_KEY, 'GEMINI_API_KEY', {
    baseUrl: env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta',
    models: { cheap: env.GEMINI_CHEAP_MODEL, frontier: env.GEMINI_FRONTIER_MODEL },
  }),
  gptzero: resolve(env.GPTZERO_MODE, env.GPTZERO_API_KEY, 'GPTZERO_API_KEY', {
    baseUrl: env.GPTZERO_BASE_URL,
  }),
};

export const config = Object.freeze({
  env: env.NODE_ENV,
  isDev: env.NODE_ENV === 'development',
  port: env.PORT,
  webOrigin: env.WEB_ORIGIN,
  persistToDisk: env.PERSIST_TO_DISK,
  sqlitePath: env.SQLITE_PATH,
  modelGateway: {
    baseUrl: env.MODEL_GATEWAY_BASE_URL ?? `http://127.0.0.1:${env.PORT}/v1`,
    apiKey: env.MODEL_GATEWAY_API_KEY,
  },
  mcpGateway: {
    url: env.MCP_GATEWAY_URL ?? `http://127.0.0.1:${env.PORT}/mcp`,
    apiKey: env.MCP_GATEWAY_API_KEY,
  },
  mock: {
    all: env.MOCK_ALL,
    failureRate: env.MOCK_FAILURE_RATE,
    minLatencyMs: env.MOCK_MIN_LATENCY_MS,
    maxLatencyMs: Math.max(env.MOCK_MIN_LATENCY_MS, env.MOCK_MAX_LATENCY_MS),
  },
  contentCheck: {
    escalationThreshold: env.GPTZERO_ESCALATION_THRESHOLD,
  },
  sentry: {
    dsn: env.SENTRY_DSN,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    release: env.SENTRY_RELEASE,
  },
  browser: {
    maxSessions: env.BROWSER_MAX_SESSIONS,
    timeoutMs: env.BROWSER_TIMEOUT_MS,
    decisionTimeoutMs: env.BROWSER_DECISION_TIMEOUT_MS,
    maxElements: env.BROWSER_MAX_ELEMENTS,
    actionTimeoutMs: env.BROWSER_ACTION_TIMEOUT_MS,
    settleMs: env.BROWSER_SETTLE_MS,
    settleSelectMs: env.BROWSER_SETTLE_SELECT_MS,
  },
  providers,
});

export function logConfigSummary(): void {
  const summary = PROVIDER_IDS.map((id) => id + '=' + providers[id].mode).join('  ');
  console.log('[config] port=' + config.port + '  mockAll=' + config.mock.all);
  console.log('[config] providers: ' + summary);
  if (env.OPENROUTER_MODE === 'live' && providers.openrouter.mode !== 'live') {
    console.warn('[setup] OPENROUTER_MODE=live requires OPENROUTER_API_KEY; using mock mode.');
  }
  if (env.COMPOSIO_MODE === 'live' && providers.composio.mode !== 'live') {
    console.warn('[setup] COMPOSIO_MODE=live requires COMPOSIO_API_KEY; using mock mode.');
  }
  if (providers.composio.mode === 'live' && !providers.composio.authConfigId) {
    console.warn('[setup] COMPOSIO_AUTH_CONFIG_ID is needed to create a new OAuth connection.');
  }
}
