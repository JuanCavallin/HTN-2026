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

/** ~4 chars per token. Good enough for a mock; live Jev would report real counts. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function createMock(cfg: ProviderConfig): DecisionAdapter {
  const base = mockBase('jev', CAPABILITIES, cfg.mode);
  return {
    ...base,
    async decide(input, ctx) {
      // Jev is a model call in reality, so the mock must report tokens or it
      // shows up as a free step in the analytics rollup. Deliberately NO
      // estimatedCostCents: Jev's real pricing is not known to us (see
      // providers/jev/live.ts), and inventing a number is worse than omitting it.
      const tokensIn = estimateTokens(input.question + (input.evidence ?? ''));
      return mockCall(
        'jev',
        'decide',
        cfg.mode,
        ctx,
        () => ({
          // Always the first option. Deterministic on purpose: a demo you rehearse
          // must take the same branch every time, and playbooks are written so that
          // options[0] is the path worth showing (the one that hits the approval gate).
          choice: input.options[0] ?? 'unknown',
          confidence: 0.82,
          rationale: 'Mock decision over ' + input.options.length + ' option(s).',
        }),
        { tokensIn, tokensOut: 24 },
      );
    },
    async route(input, ctx) {
      const tokensIn = estimateTokens(input.task + input.availableTools.join(' '));
      return mockCall(
        'jev',
        'route',
        cfg.mode,
        ctx,
        () => {
          const modelTier = pickTier(input.task);
          // Deterministic slice, not random, so a rehearsed demo shows the same
          // reduction every time — this is the M2 headline number (50+ -> 3-8).
          const exposedTools = input.availableTools.slice(
            0,
            Math.min(3, input.availableTools.length),
          );
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
        },
        { tokensIn, tokensOut: 32 },
      );
    },
  };
}
