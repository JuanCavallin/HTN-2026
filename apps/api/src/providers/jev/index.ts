import type { Capability, DecisionAdapter, IntelligenceLevel, PrivacyRoute } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveJev } from './live.js';

const CAPABILITIES: readonly Capability[] = ['decision'];

export function create(cfg: ProviderConfig): DecisionAdapter {
  if (cfg.mode === 'live') return createLiveJev(cfg);
  return createMock(cfg);
}

function pickPrivacy(task: string, context?: string): PrivacyRoute {
  return /resume|résumé|\bcv\b|private|secret|patient|medical|financial|credential|local.only/i.test(
    task + ' ' + (context ?? ''),
  )
    ? 'private'
    : 'cloud';
}

function pickIntelligence(task: string): IntelligenceLevel {
  return task.length < 160 ? 'low' : 'high';
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
          const privacy = pickPrivacy(input.task, input.context);
          const intelligence = pickIntelligence(input.task);
          const modelTier =
            privacy === 'private' ? 'local' : intelligence === 'low' ? 'cheap' : 'frontier';
          // Deterministic slice, not random, so a rehearsed demo shows the same
          // reduction every time — this is the M2 headline number (50+ -> 3-8).
          const exposedTools = input.availableTools.slice(
            0,
            Math.min(3, input.availableTools.length),
          );
          return {
            privacy,
            intelligence,
            privacyConfidence: 0.8,
            intelligenceConfidence: 0.8,
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
