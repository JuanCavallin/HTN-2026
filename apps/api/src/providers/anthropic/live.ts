/**
 * Anthropic — frontier text model. LIVE ADAPTER. NOT IMPLEMENTED.
 *
 * ============================================================================
 * TO IMPLEMENT (do this one FIRST — it is the lowest-risk live integration and
 * it unblocks real reasoning everywhere else):
 *
 *   pnpm --filter @htn/api add @anthropic-ai/sdk     (0.127.0 at scaffold time)
 *   Needs ANTHROPIC_API_KEY.
 *
 *   import Anthropic from '@anthropic-ai/sdk';
 *   const client = new Anthropic({ apiKey: cfg.apiKey });
 *   const msg = await client.messages.create({ model, max_tokens, messages, system });
 *
 * Map onto OUR TextModelAdapter.complete(). Return real token counts from
 * msg.usage — the egress ledger and the cost panel both read them.
 *
 * PRIVACY INVARIANT — DO NOT BREAK THIS:
 *   Text reaching this adapter must ALREADY be redacted. Callers pass
 *   ctx.redactions listing the placeholders present. This adapter must never be
 *   handed raw values, and must never attempt to rehydrate them. If you find
 *   yourself importing core/redaction.ts here, something upstream is wrong.
 * ============================================================================
 */

import type { ProviderResult, TextModelAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';

function notImplemented<T>(op: string): ProviderResult<T> {
  return {
    ok: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: `anthropic.${op} live adapter is not implemented yet. See providers/anthropic/live.ts.`,
      retryable: false,
    },
    meta: { provider: 'anthropic', op, mode: 'live', latencyMs: 0, destination: null },
  };
}

export function createLiveAnthropic(_cfg: ProviderConfig): TextModelAdapter {
  return {
    id: 'anthropic',
    mode: 'live',
    capabilities: ['text.model'],
    async health() {
      return notImplemented('health');
    },
    async invoke(op) {
      return notImplemented(op);
    },
    async complete() {
      return notImplemented('complete');
    },
  };
}
