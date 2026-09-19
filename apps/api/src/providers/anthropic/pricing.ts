/**
 * Per-tier token pricing, shared by the live adapter and the mock so the cost
 * column means the same thing in both modes — a demo rehearsed on mocks should
 * not show a different order of magnitude than the live run.
 *
 * Rates are cents per MILLION tokens, from the published Anthropic API pricing
 * for the models in MODEL_BY_TIER (live.ts):
 *
 *   cheap     claude-haiku-4-5   $1 / $5   per MTok
 *   standard  claude-sonnet-5    $2 / $10  per MTok
 *   frontier  claude-opus-5      $5 / $25  per MTok
 *
 * If MODEL_BY_TIER changes, change these together — they are two halves of one
 * fact.
 */

import type { ModelTier } from '@htn/shared';

export const CENTS_PER_MTOK: Record<ModelTier, { in: number; out: number }> = {
  cheap: { in: 100, out: 500 },
  standard: { in: 200, out: 1000 },
  frontier: { in: 500, out: 2500 },
};

/**
 * Cost of one call in cents. Fractional on purpose: a single cheap call is well
 * under a cent, and rounding here would report every demo as costing nothing.
 */
export function estimateCostCents(tier: ModelTier, tokensIn: number, tokensOut: number): number {
  const rate = CENTS_PER_MTOK[tier];
  return (tokensIn * rate.in + tokensOut * rate.out) / 1_000_000;
}
