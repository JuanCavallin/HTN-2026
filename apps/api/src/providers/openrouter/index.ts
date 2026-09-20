import type { ProviderAdapter, ProviderResult } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { disabled, mockBase } from '../_mock.js';

function meta(cfg: ProviderConfig, op: string, started: number) {
  return {
    provider: 'openrouter' as const,
    op,
    mode: cfg.mode,
    latencyMs: Date.now() - started,
    destination: cfg.mode === 'live' ? (cfg.baseUrl ?? null) : 'mock://openrouter',
  };
}

export function create(cfg: ProviderConfig): ProviderAdapter {
  if (cfg.mode !== 'live') return mockBase('openrouter', [], cfg.mode);

  return {
    id: 'openrouter',
    mode: 'live',
    capabilities: [],
    async health(): Promise<ProviderResult<{ detail?: string }>> {
      const started = Date.now();
      try {
        const response = await fetch(
          (cfg.baseUrl ?? 'https://openrouter.ai/api/v1') + '/auth/key',
          {
            headers: { Authorization: 'Bearer ' + cfg.apiKey },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!response.ok) {
          return {
            ok: false,
            error: {
              code: response.status === 401 || response.status === 403 ? 'AUTH' : 'UPSTREAM',
              message: 'OpenRouter credential check returned HTTP ' + response.status + '.',
              retryable: response.status === 429 || response.status >= 500,
            },
            meta: meta(cfg, 'health', started),
          };
        }
        return {
          ok: true,
          data: { detail: 'live; model gateway ready' },
          meta: meta(cfg, 'health', started),
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code:
              error instanceof DOMException && error.name === 'TimeoutError'
                ? 'TIMEOUT'
                : 'UPSTREAM',
            message: 'OpenRouter credential check failed.',
            retryable: true,
          },
          meta: meta(cfg, 'health', started),
        };
      }
    },
    async invoke<TIn, TOut>(op: string): Promise<ProviderResult<TOut>> {
      return {
        ok: false,
        error: {
          code: 'BAD_INPUT',
          message: 'OpenRouter operation is not exposed through generic invoke: ' + op,
          retryable: false,
        },
        meta: meta(cfg, op, Date.now()),
      };
    },
  };
}
