import type { ProviderAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';

/** Status-only adapter; individual MCP calls are executed by the trusted tool broker. */
export function create(cfg: ProviderConfig): ProviderAdapter {
  return {
    id: 'mcp',
    mode: cfg.mode,
    capabilities: [],
    async health() {
      return {
        ok: true,
        data: { detail: 'User-configured MCP connection manager is available.' },
        meta: {
          provider: 'mcp',
          op: 'health',
          mode: cfg.mode,
          latencyMs: 0,
          destination: 'local://mcp-connections',
        },
      };
    },
    async invoke<TIn, TOut>(op: string, _input: TIn) {
      return {
        ok: false,
        error: {
          code: 'BAD_INPUT',
          message: 'Generic invoke is unavailable for MCP operation ' + op + '.',
          retryable: false,
        },
        meta: {
          provider: 'mcp',
          op,
          mode: cfg.mode,
          latencyMs: 0,
          destination: 'local://mcp-connections',
        },
      };
    },
  };
}
