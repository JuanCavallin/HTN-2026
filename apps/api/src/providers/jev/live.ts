/**
 * Jev — fast decision layer. LIVE ADAPTER. NOT IMPLEMENTED.
 *
 * ============================================================================
 * READ THIS BEFORE WRITING CODE HERE.
 *
 * The real endpoints, auth scheme, and payload shapes for Jev are NOT known to
 * whoever scaffolded this file, and were deliberately NOT guessed.
 *
 * TO IMPLEMENT — get the docs from the sponsor, then fill in:
 *   1. Base URL              -> JEV_BASE_URL
 *   2. Auth header shape
 *   3. A single cheap classify/route call -> map to decide({ question, options, evidence })
 *
 * The `decide` signature is deliberately tiny: a question, a closed set of
 * options, and optional evidence. Keep it that way. If Jev is used as a router,
 * the options are model tiers; if as a classifier, they are labels. Same shape.
 *
 * NOTE ON CONFIDENCE: `confidence` is returned but the risk gate does NOT consume
 * it. Approval is decided by reversibility in core/risk.ts, never by a model's
 * self-reported certainty. Do not wire confidence into the gate.
 *
 * Until then: JEV_MODE=mock (the default) and everything works.
 * ============================================================================
 */

import type { DecisionAdapter, ProviderResult } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';

function notImplemented<T>(op: string): ProviderResult<T> {
  return {
    ok: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: `jev.${op} live adapter is not implemented yet. See providers/jev/live.ts.`,
      retryable: false,
    },
    meta: { provider: 'jev', op, mode: 'live', latencyMs: 0, destination: null },
  };
}

export function createLiveJev(_cfg: ProviderConfig): DecisionAdapter {
  return {
    id: 'jev',
    mode: 'live',
    capabilities: ['decision'],
    async health() {
      return notImplemented('health');
    },
    async invoke(op) {
      return notImplemented(op);
    },
    async decide() {
      return notImplemented('decide');
    },
  };
}
