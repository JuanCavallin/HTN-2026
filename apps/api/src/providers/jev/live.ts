/** Jev live adapter, backed by Vercel AI Gateway's evaluation API. */

import {
  createGateway,
  experimental_evaluate as evaluate,
  type Experimental_EvaluationQuestion,
} from 'ai';
import type {
  DecisionAdapter,
  IntelligenceLevel,
  ModelTier,
  PrivacyRoute,
  ProviderCallContext,
  ProviderError,
  ProviderResult,
} from '@htn/shared';
import type { ProviderConfig } from '../../config.js';

const MODEL_ID = 'typesafe-ai/jev';
const DEFAULT_BASE_URL = 'https://ai-gateway.vercel.sh/v4/ai';
const TOOL_THRESHOLD = 0.5;
const MAX_EXPOSED_TOOLS = 8;

function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode;
  if ('cause' in error) return statusCode(error.cause);
  return undefined;
}

function providerError(error: unknown): ProviderError {
  const status = statusCode(error);
  const message = error instanceof Error ? error.message : String(error);

  if (status === 401 || status === 403) {
    return { code: 'AUTH', message, retryable: false };
  }
  if (status === 429) {
    return { code: 'RATE_LIMIT', message, retryable: true };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'TIMEOUT', message, retryable: true };
  }
  return {
    code: 'UPSTREAM',
    message,
    retryable: status === undefined || status >= 500,
  };
}

function meta(
  op: string,
  startedAt: number,
  destination: string,
  usage?: { inputTokens?: number; outputTokens?: number },
) {
  return {
    provider: 'jev' as const,
    op,
    mode: 'live' as const,
    latencyMs: Date.now() - startedAt,
    destination,
    tokensIn: usage?.inputTokens,
    tokensOut: usage?.outputTokens,
  };
}

function probabilityForChoice(
  choice: string,
  probabilities: Record<string, number> | undefined,
): number {
  if (!probabilities) return 0;
  return probabilities[choice] ?? Math.max(0, ...Object.values(probabilities));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function createLiveJev(cfg: ProviderConfig): DecisionAdapter {
  const baseURL = cfg.baseUrl ?? DEFAULT_BASE_URL;
  const destination = baseURL + '/evaluation-model';
  const gateway = createGateway({
    apiKey: cfg.apiKey,
    ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
  });
  const model = gateway.evaluationModel(MODEL_ID);

  const decide: DecisionAdapter['decide'] = async (input, ctx) => {
    const startedAt = Date.now();
    if (input.options.length === 0) {
      return {
        ok: false,
        error: {
          code: 'BAD_INPUT',
          message: 'Jev requires at least one option.',
          retryable: false,
        },
        meta: meta('decide', startedAt, destination),
      };
    }

    try {
      const criteria = Object.fromEntries(
        input.options.map((option) => [option, 'Select when the evidence best supports ' + option]),
      );
      const result = await evaluate({
        model,
        state: {
          question: input.question,
          evidence: input.evidence ?? null,
        },
        questions: {
          decision: {
            type: 'choice',
            instructions: input.question,
            criteria,
          },
        },
        maxRetries: 2,
        abortSignal: ctx.signal,
      });
      const answer = result.answers.decision;
      const confidence = probabilityForChoice(answer.choice, answer.probabilities);

      return {
        ok: true,
        data: {
          choice: answer.choice,
          confidence,
          rationale: `Jev selected ${answer.choice} with probability ${confidence.toFixed(3)}.`,
        },
        meta: meta('decide', startedAt, destination, result.usage),
      };
    } catch (error) {
      return {
        ok: false,
        error: providerError(error),
        meta: meta('decide', startedAt, destination),
      };
    }
  };

  const route: DecisionAdapter['route'] = async (input, ctx) => {
    const startedAt = Date.now();
    try {
      const questions: Record<string, Experimental_EvaluationQuestion> = {
        privacy: {
          type: 'choice',
          instructions:
            'Decide whether this task requires a private model or may use a cloud model.',
          criteria: {
            private:
              'The task requires personal documents, local files, credentials, secrets, regulated data, or other information that must remain private.',
            cloud:
              'The task uses public or sanitized information that is allowed to be processed by a cloud model.',
          },
        },
        intelligence: {
          type: 'choice',
          instructions: 'Decide how much model intelligence this task requires.',
          criteria: {
            low: 'Routine lookup, extraction, classification, summarization, or simple transformation.',
            high: 'Difficult, ambiguous, high-stakes, creative, strategic, or deeply multi-step reasoning.',
          },
        },
      };

      const toolQuestionIds = new Map<string, string>();
      input.availableTools.forEach((tool, index) => {
        const questionId = `tool_${index}`;
        toolQuestionIds.set(questionId, tool);
        questions[questionId] = {
          type: 'boolean',
          instructions:
            `Should the agent be given the ${tool} tool for this task? ` +
            'Choose true only when the tool is directly useful. Tool selection does not grant permission.',
        };
      });

      const result = await evaluate({
        model,
        state: {
          task: input.task,
          context: input.context ?? null,
          availableTools: input.availableTools,
        },
        questions,
        maxRetries: 2,
        abortSignal: ctx.signal,
      });

      const privacyAnswer = result.answers.privacy;
      const intelligenceAnswer = result.answers.intelligence;
      if (privacyAnswer.type !== 'choice' || intelligenceAnswer.type !== 'choice') {
        throw new Error('Jev returned an invalid routing answer.');
      }

      const privacy: PrivacyRoute = privacyAnswer.choice === 'cloud' ? 'cloud' : 'private';
      const intelligence: IntelligenceLevel = intelligenceAnswer.choice === 'low' ? 'low' : 'high';
      const privacyConfidence = probabilityForChoice(
        privacyAnswer.choice,
        privacyAnswer.probabilities,
      );
      const intelligenceConfidence = probabilityForChoice(
        intelligenceAnswer.choice,
        intelligenceAnswer.probabilities,
      );
      const modelTier: ModelTier =
        privacy === 'private' ? 'local' : intelligence === 'low' ? 'cheap' : 'frontier';

      const rankedTools = [...toolQuestionIds.entries()]
        .map(([questionId, tool]) => {
          const answer = result.answers[questionId];
          return {
            tool,
            probability: answer?.type === 'boolean' ? answer.probability : 0,
          };
        })
        .sort((a, b) => b.probability - a.probability);

      const exposedTools = rankedTools
        .filter((candidate) => candidate.probability >= TOOL_THRESHOLD)
        .slice(0, MAX_EXPOSED_TOOLS)
        .map((candidate) => candidate.tool);
      const toolConfidences = rankedTools.map((candidate) =>
        Math.max(candidate.probability, 1 - candidate.probability),
      );
      const confidence = average([privacyConfidence, intelligenceConfidence, ...toolConfidences]);

      return {
        ok: true,
        data: {
          privacy,
          intelligence,
          privacyConfidence,
          intelligenceConfidence,
          modelTier,
          exposedTools,
          confidence,
          rationale:
            `Jev selected privacy=${privacy}, intelligence=${intelligence}, tier=${modelTier}, ` +
            `and exposed ${exposedTools.length} of ` +
            `${input.availableTools.length} tools at p >= ${TOOL_THRESHOLD}.`,
        },
        meta: meta('route', startedAt, destination, result.usage),
      };
    } catch (error) {
      return {
        ok: false,
        error: providerError(error),
        meta: meta('route', startedAt, destination),
      };
    }
  };

  return {
    id: 'jev',
    mode: 'live',
    capabilities: ['decision'],
    async health() {
      const startedAt = Date.now();
      try {
        if (!cfg.apiKey) {
          return {
            ok: false,
            error: { code: 'AUTH', message: 'AI_GATEWAY_API_KEY is missing.', retryable: false },
            meta: meta('health', startedAt, baseURL),
          };
        }
        await gateway.getCredits();
        return {
          ok: true,
          data: { detail: `Vercel AI Gateway · ${MODEL_ID}` },
          meta: meta('health', startedAt, baseURL),
        };
      } catch (error) {
        return {
          ok: false,
          error: providerError(error),
          meta: meta('health', startedAt, baseURL),
        };
      }
    },
    async invoke<TIn, TOut>(
      op: string,
      input: TIn,
      ctx: ProviderCallContext,
    ): Promise<ProviderResult<TOut>> {
      if (op === 'decide') {
        return (await decide(
          input as Parameters<DecisionAdapter['decide']>[0],
          ctx,
        )) as ProviderResult<TOut>;
      }
      if (op === 'route') {
        return (await route(
          input as Parameters<DecisionAdapter['route']>[0],
          ctx,
        )) as ProviderResult<TOut>;
      }
      return {
        ok: false,
        error: { code: 'BAD_INPUT', message: `Unknown Jev operation: ${op}`, retryable: false },
        meta: meta(op, Date.now(), destination),
      };
    },
    decide,
    route,
  };
}
