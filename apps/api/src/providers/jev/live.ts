/** Jev live adapter, backed by Vercel AI Gateway's evaluation API. */

import {
  createGateway,
  experimental_evaluate as evaluate,
  type Experimental_EvaluationQuestion,
} from 'ai';
import type {
  ActionPolicy,
  CompletionStatus,
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
const LOCAL_PRECHECK_DESTINATION = 'local://jev-precheck';
const JEV_TIMEOUT_MS = 20_000;

function decisionSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(JEV_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

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
        abortSignal: decisionSignal(ctx.signal),
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

  const selectModel: DecisionAdapter['selectModel'] = async (input, ctx) => {
    const startedAt = Date.now();
    if (input.candidates.length === 0) {
      return {
        ok: false,
        error: {
          code: 'BAD_INPUT',
          message: 'selectModel requires at least one eligible candidate.',
          retryable: false,
        },
        meta: meta('select_model', startedAt, LOCAL_PRECHECK_DESTINATION),
      };
    }

    try {
      const result = await evaluate({
        model,
        state: {
          task: input.state.taskSummary,
          context: input.state.contextSummary ?? null,
          dataLabels: input.state.dataLabels,
        },
        questions: {
          modelRoute: {
            type: 'choice',
            instructions:
              'Choose the cheapest route that can reliably complete the task. Choose only from the supplied eligible routes.',
            criteria: Object.fromEntries(
              input.candidates.map((candidate) => [
                candidate.id,
                [
                  `deployment=${candidate.deployment}`,
                  `cost=${candidate.costTier}`,
                  `context=${candidate.contextScope}`,
                  `tools=${candidate.supportsTools}`,
                ].join(', '),
              ]),
            ),
          },
        },
        maxRetries: 2,
        abortSignal: decisionSignal(ctx.signal),
      });
      const answer = result.answers.modelRoute;
      if (answer.type !== 'choice') throw new Error('Jev returned an invalid model choice.');
      const candidateIds = new Set(input.candidates.map((candidate) => candidate.id));
      if (!candidateIds.has(answer.choice)) throw new Error('Jev selected an unknown model route.');
      const confidence = probabilityForChoice(answer.choice, answer.probabilities);
      return {
        ok: true,
        data: {
          selectedRouteId: answer.choice,
          confidence,
          probabilities: answer.probabilities ?? {},
          reasonCodes: ['jev-model-route-choice'],
        },
        meta: meta('select_model', startedAt, destination, result.usage),
      };
    } catch (error) {
      return {
        ok: false,
        error: providerError(error),
        meta: meta('select_model', startedAt, destination),
      };
    }
  };

  const selectToolFamilies: DecisionAdapter['selectToolFamilies'] = async (input, ctx) => {
    const startedAt = Date.now();
    if (input.candidateFamilies.length === 0) {
      return {
        ok: true,
        data: { selectedFamilies: [], confidences: {}, reasonCodes: ['no-tool-families'] },
        meta: meta('select_tool_families', startedAt, LOCAL_PRECHECK_DESTINATION),
      };
    }

    try {
      const questions: Record<string, Experimental_EvaluationQuestion> = {};
      input.candidateFamilies.forEach((family, index) => {
        questions[`family_${index}`] = {
          type: 'boolean',
          instructions: `Does this task need the ${family} tool family? Select true only when directly useful.`,
        };
      });
      const result = await evaluate({
        model,
        state: {
          task: input.state.taskSummary,
          context: input.state.contextSummary ?? null,
          candidateFamilies: input.candidateFamilies,
        },
        questions,
        maxRetries: 2,
        abortSignal: decisionSignal(ctx.signal),
      });
      const confidences = Object.fromEntries(
        input.candidateFamilies.map((family, index) => {
          const answer = result.answers[`family_${index}`];
          return [family, answer?.type === 'boolean' ? answer.probability : 0];
        }),
      );
      return {
        ok: true,
        data: {
          selectedFamilies: input.candidateFamilies.filter(
            (family) => (confidences[family] ?? 0) >= TOOL_THRESHOLD,
          ),
          confidences,
          reasonCodes: ['jev-tool-family-filter'],
        },
        meta: meta('select_tool_families', startedAt, destination, result.usage),
      };
    } catch (error) {
      return {
        ok: false,
        error: providerError(error),
        meta: meta('select_tool_families', startedAt, destination),
      };
    }
  };

  const selectTools: DecisionAdapter['selectTools'] = async (input, ctx) => {
    const startedAt = Date.now();
    if (input.candidates.length === 0) {
      return {
        ok: true,
        data: { selectedToolIds: [], confidences: {}, reasonCodes: ['no-eligible-tools'] },
        meta: meta('select_tools', startedAt, LOCAL_PRECHECK_DESTINATION),
      };
    }

    try {
      const questions: Record<string, Experimental_EvaluationQuestion> = {};
      input.candidates.forEach((tool, index) => {
        questions[`tool_${index}`] = {
          type: 'boolean',
          instructions:
            `Should the agent receive tool ${tool.id} (${tool.description}) for this task? ` +
            'Select true only when directly useful. Selection never grants execution permission.',
        };
      });
      const result = await evaluate({
        model,
        state: {
          task: input.state.taskSummary,
          context: input.state.contextSummary ?? null,
          tools: input.candidates.map(({ id, family, description, baselineEffect }) => ({
            id,
            family,
            description,
            baselineEffect,
          })),
        },
        questions,
        maxRetries: 2,
        abortSignal: decisionSignal(ctx.signal),
      });
      const confidences = Object.fromEntries(
        input.candidates.map((tool, index) => {
          const answer = result.answers[`tool_${index}`];
          return [tool.id, answer?.type === 'boolean' ? answer.probability : 0];
        }),
      );
      const maxTools = Math.max(
        0,
        Math.min(input.maxTools ?? MAX_EXPOSED_TOOLS, MAX_EXPOSED_TOOLS),
      );
      const selectedToolIds = input.candidates
        .map((tool) => ({ id: tool.id, probability: confidences[tool.id] ?? 0 }))
        .filter(({ probability }) => probability >= TOOL_THRESHOLD)
        .sort((a, b) => b.probability - a.probability)
        .slice(0, maxTools)
        .map(({ id }) => id);
      return {
        ok: true,
        data: {
          selectedToolIds,
          confidences,
          reasonCodes: ['jev-tool-filter'],
        },
        meta: meta('select_tools', startedAt, destination, result.usage),
      };
    } catch (error) {
      return {
        ok: false,
        error: providerError(error),
        meta: meta('select_tools', startedAt, destination),
      };
    }
  };

  const recommendActionPolicy: DecisionAdapter['recommendActionPolicy'] = async (input, ctx) => {
    const startedAt = Date.now();
    try {
      const result = await evaluate({
        model,
        state: {
          operation: input.action.operation,
          destination: input.action.destination ?? null,
          dataLabels: input.action.dataLabels,
          tool: {
            id: input.descriptor.id,
            description: input.descriptor.description,
            baselineEffect: input.descriptor.baselineEffect,
            reversibility: input.descriptor.reversibility,
          },
          task: input.state.taskSummary,
        },
        questions: {
          actionPolicy: {
            type: 'choice',
            instructions:
              'Recommend a semantic action policy. Be conservative; this recommendation cannot override deterministic policy.',
            criteria: {
              auto: 'A reversible, read-only, low-impact action that may run automatically.',
              verify: 'An action that may run but requires deterministic result verification.',
              ask_user:
                'An external side effect or consequential action requiring exact-action user approval.',
              deny: 'An unsafe, unknown, disallowed, or policy-incompatible action.',
            },
          },
        },
        maxRetries: 2,
        abortSignal: decisionSignal(ctx.signal),
      });
      const answer = result.answers.actionPolicy;
      if (answer.type !== 'choice') throw new Error('Jev returned an invalid action policy.');
      const allowed = new Set<ActionPolicy>(['auto', 'verify', 'ask_user', 'deny']);
      if (!allowed.has(answer.choice as ActionPolicy))
        throw new Error('Jev returned an unknown action policy.');
      const policy = answer.choice as ActionPolicy;
      return {
        ok: true,
        data: {
          policy,
          confidence: probabilityForChoice(answer.choice, answer.probabilities),
          probabilities: answer.probabilities ?? {},
          reasonCodes: ['jev-semantic-action-policy'],
        },
        meta: meta('recommend_action_policy', startedAt, destination, result.usage),
      };
    } catch (error) {
      return {
        ok: false,
        error: providerError(error),
        meta: meta('recommend_action_policy', startedAt, destination),
      };
    }
  };

  const judgeCompletion: DecisionAdapter['judgeCompletion'] = async (input, ctx) => {
    const startedAt = Date.now();
    try {
      const remainingSteps = input.checkpoint.steps
        .filter((step) => step.required && step.status !== 'succeeded')
        .map((step) => ({ id: step.id, label: step.label, status: step.status }));
      const result = await evaluate({
        model,
        state: {
          objective: input.sanitizedState.taskSummary,
          context: input.sanitizedState.contextSummary ?? null,
          steps: input.checkpoint.steps.map((step) => ({
            id: step.id,
            status: step.status,
            required: step.required,
            summary: step.sanitizedSummary ?? null,
          })),
          artifacts: input.checkpoint.artifacts.map((artifact) => ({
            id: artifact.id,
            kind: artifact.kind,
            required: artifact.required,
            verified: artifact.verified,
            summary: artifact.sanitizedSummary ?? null,
          })),
          verifications: input.checkpoint.verifications.map((verification) => ({
            id: verification.id,
            passed: verification.passed,
            required: verification.required,
            reasonCode: verification.reasonCode,
          })),
          outstandingRequirements: input.checkpoint.outstandingRequirements,
          pendingApprovalCount: input.checkpoint.pendingApprovalIds.length,
          budget: {
            stepsRemaining: input.checkpoint.budget.stepsRemaining,
            timeRemainingMs: input.checkpoint.budget.timeRemainingMs ?? null,
            tokensRemaining: input.checkpoint.budget.tokensRemaining ?? null,
            costRemainingCents: input.checkpoint.budget.costRemainingCents ?? null,
          },
        },
        questions: {
          completion: {
            type: 'choice',
            instructions:
              'Judge whether the stated objective is complete, should continue, or is blocked.',
            criteria: {
              done: 'The objective and every required output are satisfied with no remaining work.',
              continue:
                'Useful required work remains and the task can make progress within its budget.',
              blocked:
                'The task needs user input, approval, unavailable capability, or has exhausted its budget.',
            },
          },
          ...(remainingSteps.length > 0
            ? {
                nextStep: {
                  type: 'choice' as const,
                  instructions: 'If continuing, choose the most useful remaining required step.',
                  criteria: Object.fromEntries(
                    remainingSteps.map((step) => [step.id, `${step.label}; status=${step.status}`]),
                  ),
                },
              }
            : {}),
        },
        maxRetries: 2,
        abortSignal: decisionSignal(ctx.signal),
      });
      const answer = result.answers.completion;
      if (answer.type !== 'choice') throw new Error('Jev returned an invalid completion judgment.');
      const statuses = new Set<CompletionStatus>(['done', 'continue', 'blocked']);
      if (!statuses.has(answer.choice as CompletionStatus)) {
        throw new Error('Jev returned an unknown completion status.');
      }
      const status = answer.choice as CompletionStatus;
      const nextStep = result.answers.nextStep;
      return {
        ok: true,
        data: {
          status,
          confidence: probabilityForChoice(answer.choice, answer.probabilities),
          probabilities: answer.probabilities ?? {},
          reasonCodes: ['jev-completion-judgment'],
          suggestedNextStepId:
            status === 'continue' && nextStep?.type === 'choice' ? nextStep.choice : undefined,
        },
        meta: meta('judge_completion', startedAt, destination, result.usage),
      };
    } catch (error) {
      return {
        ok: false,
        error: providerError(error),
        meta: meta('judge_completion', startedAt, destination),
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
        abortSignal: decisionSignal(ctx.signal),
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
      if (op === 'select_model') {
        return (await selectModel(
          input as Parameters<DecisionAdapter['selectModel']>[0],
          ctx,
        )) as ProviderResult<TOut>;
      }
      if (op === 'select_tool_families') {
        return (await selectToolFamilies(
          input as Parameters<DecisionAdapter['selectToolFamilies']>[0],
          ctx,
        )) as ProviderResult<TOut>;
      }
      if (op === 'select_tools') {
        return (await selectTools(
          input as Parameters<DecisionAdapter['selectTools']>[0],
          ctx,
        )) as ProviderResult<TOut>;
      }
      if (op === 'recommend_action_policy') {
        return (await recommendActionPolicy(
          input as Parameters<DecisionAdapter['recommendActionPolicy']>[0],
          ctx,
        )) as ProviderResult<TOut>;
      }
      if (op === 'judge_completion') {
        return (await judgeCompletion(
          input as Parameters<DecisionAdapter['judgeCompletion']>[0],
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
    selectModel,
    selectToolFamilies,
    selectTools,
    recommendActionPolicy,
    judgeCompletion,
    route,
  };
}
