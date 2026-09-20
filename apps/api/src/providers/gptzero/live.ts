/**
 * GPTZero — live AI-content analysis.
 *
 * ============================================================================
 * WHAT THIS IS FOR — read before moving the call site.
 *
 * This is NOT a detector on inbound content. Scoring what the web or a model
 * hands us tells us nothing we can act on. It is a self-check on OUTBOUND text:
 * anything AgentOS writes in the USER'S name — an email body, a support-desk
 * message, a form field — gets scored immediately before it sends.
 *
 * The product claim it backs: "the agent does not send machine-sounding text
 * under your name without telling you first." That is a policy escalation, so
 * the wiring lives in the tool broker (core/tools/contentCheck.ts), between
 * authorization and execution, and it may only ever escalate. See that file.
 * ---------------------------------------------------------------------------
 * API SHAPE — confirmed against GPTZero's published v2 docs, NOT against a live
 * key (no key was available when this was written). Everything below is parsed
 * defensively for that reason: a field that moves degrades the score to
 * `inconclusive` instead of throwing, and an unusable response never blocks a
 * send on its own.
 *
 *   POST https://api.gptzero.me/v2/predict/text
 *   header: x-api-key: <key>
 *   body:   { document: string, version?: string }
 *   200:    { documents: [ {
 *              class_probabilities: { human: number, ai: number, mixed: number },
 *              predicted_class: 'human' | 'ai' | 'mixed',
 *              completely_generated_prob?: number,
 *              document_classification?: string,
 *            } ] }
 *
 * `score` is normalised to P(ai) in 0..1 so callers never have to know which of
 * the three probability fields the API happened to populate.
 * ============================================================================
 */

import type {
  Capability,
  ContentAnalysisAdapter,
  ProviderCallContext,
  ProviderErrorCode,
  ProviderResult,
} from '@htn/shared';
import type { ProviderConfig } from '../../config.js';

const CAPABILITIES: readonly Capability[] = ['content.analysis'];
const DEFAULT_BASE_URL = 'https://api.gptzero.me';
const TIMEOUT_MS = 12_000;

/**
 * Our own deadline, ALWAYS applied.
 *
 * A caller-supplied signal is a cancellation, not a timeout — a run that is
 * never cancelled would otherwise let a hung GPTZero request hold the tool
 * broker open indefinitely, and the broker is mid-authorization when it calls
 * here. Same shape as jev/live.ts decisionSignal().
 */
function scoringSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** GPTZero rejects trivially short input; below this we do not spend the call. */
const MIN_SCOREABLE_CHARS = 32;
/** The API's own document ceiling. Longer text is scored on its leading slice. */
const MAX_DOCUMENT_CHARS = 50_000;

interface RawDocument {
  class_probabilities?: { human?: unknown; ai?: unknown; mixed?: unknown };
  predicted_class?: unknown;
  completely_generated_prob?: unknown;
  average_generated_prob?: unknown;
  document_classification?: unknown;
}

interface RawResponse {
  documents?: RawDocument[];
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Clamp into 0..1 — a probability outside that range is a parse error, not a signal. */
function probability(value: unknown): number | undefined {
  const parsed = num(value);
  if (parsed === undefined) return undefined;
  return Math.min(1, Math.max(0, parsed));
}

function meta(cfg: ProviderConfig, op: string, started: number) {
  return {
    provider: 'gptzero' as const,
    op,
    mode: cfg.mode,
    latencyMs: Date.now() - started,
    destination: cfg.baseUrl ?? DEFAULT_BASE_URL,
  };
}

function errorCode(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 400 || status === 422) return 'BAD_INPUT';
  return 'UPSTREAM';
}

/**
 * Reduce GPTZero's three-class output to the single number the policy gate
 * needs. Preference order matters: the explicit `ai` class probability is the
 * calibrated one, so the generated-prob fields are only fallbacks.
 */
function aiProbabilityOf(doc: RawDocument): number | undefined {
  return (
    probability(doc.class_probabilities?.ai) ??
    probability(doc.completely_generated_prob) ??
    probability(doc.average_generated_prob)
  );
}

function labelOf(doc: RawDocument, aiProbability: number | undefined): string {
  const predicted = doc.predicted_class;
  if (predicted === 'ai' || predicted === 'human' || predicted === 'mixed') return predicted;
  if (typeof doc.document_classification === 'string' && doc.document_classification) {
    return doc.document_classification;
  }
  if (aiProbability === undefined) return 'inconclusive';
  return aiProbability >= 0.5 ? 'ai' : 'human';
}

export function createLiveGptzero(cfg: ProviderConfig): ContentAnalysisAdapter {
  const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  async function post<T>(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
    const response = await fetch(baseUrl + path, {
      method: 'POST',
      headers: {
        'x-api-key': cfg.apiKey ?? '',
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: scoringSignal(signal),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: 'GPTZero returned HTTP ' + response.status + '.',
      };
    }
    return { ok: true, data: (await response.json()) as T };
  }

  return {
    id: 'gptzero',
    mode: 'live',
    capabilities: CAPABILITIES,

    async health(): Promise<ProviderResult<{ detail?: string }>> {
      const started = Date.now();
      try {
        // There is no dedicated health route, so the cheapest real call doubles
        // as the credential probe. A 200 here proves the key, not just the host.
        const result = await post<RawResponse>(
          '/v2/predict/text',
          { document: 'AgentOS provider health probe. '.repeat(3) },
          undefined,
        );
        if (!result.ok) {
          return {
            ok: false,
            error: {
              code: errorCode(result.status),
              message: result.message,
              retryable: result.status === 429 || result.status >= 500,
            },
            meta: meta(cfg, 'health', started),
          };
        }
        return {
          ok: true,
          data: { detail: 'live; outbound text scoring ready' },
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
            message: 'GPTZero credential check failed.',
            retryable: true,
          },
          meta: meta(cfg, 'health', started),
        };
      }
    },

    async analyze(
      input: { text: string },
      ctx: ProviderCallContext,
    ): Promise<ProviderResult<{ score: number; label: string }>> {
      const started = Date.now();
      const document = input.text.trim();

      // Short strings are not scoreable, and asking anyway burns quota to get a
      // 400 back. Answer honestly rather than pretending the text looks human.
      if (document.length < MIN_SCOREABLE_CHARS) {
        return {
          ok: true,
          data: { score: 0, label: 'inconclusive' },
          meta: meta(cfg, 'analyze', started),
        };
      }

      try {
        const result = await post<RawResponse>(
          '/v2/predict/text',
          { document: document.slice(0, MAX_DOCUMENT_CHARS) },
          ctx.signal,
        );
        if (!result.ok) {
          return {
            ok: false,
            error: {
              code: errorCode(result.status),
              message: result.message,
              retryable: result.status === 429 || result.status >= 500,
            },
            meta: meta(cfg, 'analyze', started),
          };
        }

        const doc = result.data.documents?.[0];
        if (!doc) {
          return {
            ok: false,
            error: {
              code: 'UPSTREAM',
              message: 'GPTZero returned no scored document.',
              retryable: true,
            },
            meta: meta(cfg, 'analyze', started),
          };
        }

        const aiProbability = aiProbabilityOf(doc);
        return {
          ok: true,
          data: {
            score: aiProbability ?? 0,
            label: labelOf(doc, aiProbability),
          },
          meta: meta(cfg, 'analyze', started),
        };
      } catch (error) {
        // AbortError = the run cancelled us; TimeoutError = our own deadline.
        // Both are timeouts as far as the caller is concerned, and neither is
        // an upstream fault, so do not report them as one.
        const aborted =
          error instanceof DOMException &&
          (error.name === 'TimeoutError' || error.name === 'AbortError');
        const timedOut = aborted;
        return {
          ok: false,
          error: {
            code: timedOut ? 'TIMEOUT' : 'UPSTREAM',
            message: timedOut
              ? 'GPTZero scoring timed out.'
              : 'GPTZero scoring failed: ' +
                (error instanceof Error ? error.message : 'unknown error'),
            retryable: true,
          },
          meta: meta(cfg, 'analyze', started),
        };
      }
    },

    async invoke<TIn, TOut>(op: string): Promise<ProviderResult<TOut>> {
      return {
        ok: false,
        error: {
          code: 'BAD_INPUT',
          message: 'GPTZero operation is not exposed through generic invoke: ' + op,
          retryable: false,
        },
        meta: meta(cfg, op, Date.now()),
      };
    },
  };
}
