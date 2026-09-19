import type { Capability, DecisionAdapter, ModelTier } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveJev } from './live.js';

const CAPABILITIES: readonly Capability[] = ['decision'];

export function create(cfg: ProviderConfig): DecisionAdapter {
  if (cfg.mode === 'live') return createLiveJev(cfg);
  return createMock(cfg);
}

/**
 * Picks a tier by task length. A real classifier will look at actual task
 * difficulty; this is deliberately simple and DETERMINISTIC so a rehearsed
 * demo shows the same tier every time.
 */
function pickTier(task: string): ModelTier {
  if (task.length < 60) return 'cheap';
  if (task.length < 160) return 'standard';
  return 'frontier';
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
    async route(input, ctx) {
      return mockCall('jev', 'route', cfg.mode, ctx, () => {
        const modelTier = pickTier(input.task);
        // Deterministic slice, not random, so a rehearsed demo shows the same
        // reduction every time — this is the M2 headline number (50+ -> 3-8).
        const exposedTools = input.availableTools.slice(0, Math.min(3, input.availableTools.length));
        return {
          modelTier,
          exposedTools,
          confidence: 0.78,
          rationale:
            'Mock route: exposed ' +
            exposedTools.length +
            ' of ' +
            input.availableTools.length +
            ' candidate tool(s), tier=' +
            modelTier +
            '.',
        };
      });
    },
  };
}
