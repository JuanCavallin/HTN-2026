import type { Capability, DecisionAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveJev } from './live.js';

const CAPABILITIES: readonly Capability[] = ['decision'];

export function create(cfg: ProviderConfig): DecisionAdapter {
  if (cfg.mode === 'live') return createLiveJev(cfg);
  return createMock(cfg);
}

function createMock(cfg: ProviderConfig): DecisionAdapter {
  const base = mockBase('jev', CAPABILITIES, cfg.mode);
  return {
    ...base,
    async decide(input, ctx) {
      return mockCall('jev', 'decide', cfg.mode, ctx, () => ({
        // Always the first option. Deterministic on purpose: a demo you rehearse
        // must take the same branch every time, and playbooks are written so that
        // options[0] is the path worth showing (the one that hits the approval gate).
        choice: input.options[0] ?? 'unknown',
        confidence: 0.82,
        rationale: 'Mock decision over ' + input.options.length + ' option(s).',
      }));
    },
  };
}
