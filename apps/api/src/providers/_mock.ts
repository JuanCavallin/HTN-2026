/**
 * Shared mock machinery. Each provider's mock is ~20 lines because of this file.
 *
 * Mock behaviour is not "return instantly with a canned string". It deliberately:
 *   - adds jittered latency, so the UI's loading states get built in hour 3
 *   - can fail at MOCK_FAILURE_RATE, so error states get built too
 *   - still reports a destination (mock://<id>), so the egress ledger is
 *     demonstrable before a single API key exists
 */

import type {
  Capability,
  ProviderAdapter,
  ProviderCallContext,
  ProviderId,
  ProviderMode,
  ProviderResult,
} from '@htn/shared';
import { config } from '../config.js';

function jitter(): number {
  const { minLatencyMs, maxLatencyMs } = config.mock;
  return minLatencyMs + Math.random() * Math.max(0, maxLatencyMs - minLatencyMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MockCostMeta {
  tokensIn?: number;
  tokensOut?: number;
  estimatedCostCents?: number;
}

function meta(
  id: ProviderId,
  op: string,
  mode: ProviderMode,
  latencyMs: number,
  cost?: MockCostMeta,
) {
  return {
    provider: id,
    op,
    mode,
    latencyMs: Math.round(latencyMs),
    destination: mode === 'mock' ? `mock://${id}` : null,
    ...cost,
  };
}

export function disabled<T>(id: ProviderId, op: string): ProviderResult<T> {
  return {
    ok: false,
    error: {
      code: 'DISABLED',
      message: `Provider "${id}" is disabled. Set ${id.toUpperCase()}_MODE=mock to enable it.`,
      retryable: false,
    },
    meta: meta(id, op, 'disabled', 0),
  };
}

/**
 * Run a mocked operation: wait, maybe fail, wrap the result.
 * `produce` is only called when the call "succeeds".
 */
export async function mockCall<T>(
  id: ProviderId,
  op: string,
  mode: ProviderMode,
  _ctx: ProviderCallContext,
  produce: () => T,
  /** Optional cost accounting to attach to a successful result's meta. */
  cost?: MockCostMeta,
): Promise<ProviderResult<T>> {
  if (mode === 'disabled') return disabled<T>(id, op);

  const started = Date.now();
  await sleep(jitter());

  if (config.mock.failureRate > 0 && Math.random() < config.mock.failureRate) {
    return {
      ok: false,
      error: {
        code: 'UPSTREAM',
        message: `Simulated failure from ${id}.${op} (MOCK_FAILURE_RATE=${config.mock.failureRate})`,
        retryable: true,
      },
      meta: meta(id, op, mode, Date.now() - started),
    };
  }

  return { ok: true, data: produce(), meta: meta(id, op, mode, Date.now() - started, cost) };
}

/**
 * The parts of ProviderAdapter that every mock shares: identity, health, and the
 * generic `invoke` escape hatch.
 */
export function mockBase(
  id: ProviderId,
  capabilities: readonly Capability[],
  mode: ProviderMode,
): ProviderAdapter {
  return {
    id,
    mode,
    capabilities,
    async health() {
      if (mode === 'disabled') return disabled<{ detail?: string }>(id, 'health');
      return {
        ok: true,
        data: { detail: mode === 'mock' ? 'mock fixtures' : 'live' },
        meta: meta(id, 'health', mode, 0),
      };
    },
    async invoke<TIn, TOut>(op: string, input: TIn, ctx: ProviderCallContext) {
      return mockCall<TOut>(id, op, mode, ctx, () => ({ echoed: input }) as TOut);
    },
  };
}

/** Stable pseudo-random pick, so a rehearsed demo looks the same every time. */
export function pick<T>(items: readonly T[], seed: string): T {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return items[hash % items.length] as T;
}
