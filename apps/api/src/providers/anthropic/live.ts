/**
 * Anthropic — frontier text model. LIVE ADAPTER, implemented.
 *
 * ============================================================================
 * Needs ANTHROPIC_API_KEY. Nothing else — no cwd, no project id, a plain
 * HTTP API unlike Hermes.
 *
 * Model tier maps onto a real Anthropic model, not just a label:
 *   cheap    -> Haiku 4.5   (claude-haiku-4-5-20251001)
 *   standard -> Sonnet 5    (claude-sonnet-5)
 *   frontier -> Opus 5      (claude-opus-5)
 * `tier` on the call defaults to 'standard' when the caller doesn't specify
 * one (most existing call sites predate the tier field and don't pass it).
 *
 * PRIVACY INVARIANT — DO NOT BREAK THIS:
 *   Text reaching this adapter must ALREADY be redacted. Callers pass
 *   ctx.redactions listing the placeholders present; this adapter must never
 *   be handed raw values and must never attempt to rehydrate them. If you
 *   find yourself importing core/redaction.ts here, something upstream broke.
 * ============================================================================
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ModelTier, ProviderResult, TextModelAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';

const MODEL_BY_TIER: Record<ModelTier, string> = {
  cheap: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-5',
  frontier: 'claude-opus-5',
};

function meta(op: string, started: number) {
  return {
    provider: 'anthropic' as const,
    op,
    mode: 'live' as const,
    latencyMs: Date.now() - started,
    destination: 'https://api.anthropic.com',
  };
}

function failure<T>(op: string, started: number, err: unknown): ProviderResult<T> {
  const message = err instanceof Anthropic.APIError ? err.message : (err as Error).message;
  const status = err instanceof Anthropic.APIError ? err.status : undefined;
  return {
    ok: false,
    error: {
      code: status === 401 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : 'UPSTREAM',
      message,
      retryable: status !== 401 && status !== 400,
    },
    meta: meta(op, started),
  };
}

export function createLiveAnthropic(cfg: ProviderConfig): TextModelAdapter {
  const client = new Anthropic({ apiKey: cfg.apiKey });

  return {
    id: 'anthropic',
    mode: 'live',
    capabilities: ['text.model'],

    async health() {
      const started = Date.now();
      if (!cfg.apiKey) {
        return {
          ok: false,
          error: { code: 'AUTH', message: 'ANTHROPIC_API_KEY is not set', retryable: false },
          meta: meta('health', started),
        };
      }
      // A real ping without spending a real completion call: list models.
      try {
        await client.models.list({ limit: 1 });
        return { ok: true, data: {}, meta: meta('health', started) };
      } catch (err) {
        return failure('health', started, err);
      }
    },

    async invoke(op) {
      return failure(op, Date.now(), new Error('No generic invoke() op is defined for anthropic.'));
    },

    async complete(input) {
      const started = Date.now();
      try {
        const model = MODEL_BY_TIER[input.tier ?? 'standard'];
        const message = await client.messages.create({
          model,
          max_tokens: input.maxTokens ?? 1024,
          system: input.system,
          messages: [{ role: 'user', content: input.prompt }],
        });

        const text = message.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');

        return {
          ok: true,
          data: {
            text,
            tokensIn: message.usage.input_tokens,
            tokensOut: message.usage.output_tokens,
          },
          meta: meta('complete', started),
        };
      } catch (err) {
        return failure('complete', started, err);
      }
    },
  };
}
