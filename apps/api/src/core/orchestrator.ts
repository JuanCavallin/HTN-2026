/**
 * Run lifecycle: start -> steps -> (block on approval) -> finish.
 *
 * DEPENDENCY RULE: this file imports no express, no fetch, and no vendor SDK.
 * The store and providers arrive as constructor arguments (the Store *type* is
 * imported type-only, which creates no runtime coupling), so the orchestrator is
 * unit-testable and survives a swap of either.
 */

import type {
  Capability,
  CapabilityMap,
  CompletionDecision,
  ControlDecisionOperation,
  DataLabel,
  DecisionState,
  Json,
  ProposedAction,
  ProviderCallContext,
  ProviderId,
  Run,
  ScheduleDecision,
  SessionCheckpoint,
  Step,
  ToolDescriptor,
} from '@htn/shared';
import { stripPiiValue } from '@htn/shared';
import type { Store } from '../store/types.js';
import { newId, nowIso } from '../lib/ids.js';
import { ApprovalRejectedError, waitForApproval } from './approvalGate.js';
import type { RunBus } from './bus.js';
import { buildEgressEvent } from './ledger.js';
import { detectPii } from './redaction.js';
import { classify } from './risk.js';
import type { DecisionService } from './decisions/service.js';
import type { SessionStateService } from './sessions/service.js';
import type { ToolRegistry } from './tools/registry.js';
import { fanOut, type FanOutOutcome } from './swarm.js';
import { getPlaybook } from './playbooks/registry.js';
import type {
  AgentTaskResult,
  AgentTaskSpec,
  FanOutSpec,
  PlaybookContext,
  RedactionOutput,
  StepSpec,
} from './playbooks/types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OrchestratorDeps {
  store: Store;
  bus: RunBus;
  provider: <C extends Capability>(capability: C) => CapabilityMap[C];
  /** Reads the registry's live BINDINGS, so a re-point is reflected everywhere. */
  providerFor: (capability: Capability) => ProviderId;
  decisionService: DecisionService;
  sessionStateService: SessionStateService;
  toolRegistry?: ToolRegistry;
  toolDiscovery?: {
    discoverForTask(input: {
      query: string;
      runId: string;
      stepId?: string;
      signal?: AbortSignal;
    }): Promise<{ registered: string[]; skipped: string[]; warning?: string }>;
  };
  /** Cached/local catalog sources, including user-configured MCP servers. */
  localToolCandidates?: () => Promise<string[]>;
}

export class Orchestrator {
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /** True while a run is executing in this process. */
  isRunning(runId: string): boolean {
    return this.inFlight.has(runId);
  }

  cancel(runId: string): boolean {
    const controller = this.inFlight.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * Fire-and-forget. The HTTP layer responds 201 immediately; progress arrives
   * over SSE. Never await this from a route handler.
   */
  start(run: Run): void {
    void this.execute(run).catch((err) => {
      console.error('[orchestrator] unhandled failure for run ' + run.id, err);
    });
  }

  private async execute(run: Run): Promise<void> {
    const { store, bus } = this.deps;
    const controller = new AbortController();
    this.inFlight.set(run.id, controller);

    try {
      const playbook = getPlaybook(run.kind);
      if (!playbook) throw new Error('No playbook registered for kind "' + run.kind + '"');

      const parsed = playbook.inputSchema.safeParse(run.input);
      if (!parsed.success) {
        throw new Error('Invalid input for playbook "' + run.kind + '": ' + parsed.error.message);
      }

      await this.patchRun(run.id, { status: 'running' });

      const ctx = this.createContext(run.id, controller.signal);
      const outcome = await playbook.execute(ctx, parsed.data as never);

      await this.patchRun(run.id, {
        status: 'succeeded',
        summary: outcome.summary,
        result: outcome.result,
      });
    } catch (err) {
      await this.finishWithError(run.id, err as Error, controller.signal.aborted);
    } finally {
      this.inFlight.delete(run.id);
      void bus;
      void store;
    }
  }

  private async finishWithError(runId: string, err: Error, aborted: boolean): Promise<void> {
    if (err instanceof ApprovalRejectedError) {
      await this.patchRun(runId, {
        status: 'cancelled',
        summary: 'Stopped: you declined the action.',
        error: { code: err.code, message: err.message },
      });
      return;
    }
    if (aborted) {
      await this.patchRun(runId, { status: 'cancelled', summary: 'Cancelled.' });
      return;
    }
    await this.patchRun(runId, {
      status: 'failed',
      summary: err.message,
      error: { code: 'RUN_FAILED', message: err.message },
    });
  }

  private async patchRun(runId: string, patch: Partial<Run>): Promise<Run> {
    const run = await this.deps.store.patchRun(runId, patch);
    await this.deps.bus.emit(runId, { type: 'run.updated', run });
    return run;
  }

  private async upsertStep(stepId: string, patch: Partial<Step>): Promise<Step> {
    const step = await this.deps.store.patchStep(stepId, patch);
    await this.deps.bus.emit(step.runId, { type: 'step.upserted', step });
    return step;
  }

  /* ------------------------------------------------------------------ */
  /* The PlaybookContext implementation                                 */
  /* ------------------------------------------------------------------ */

  private createContext(runId: string, signal: AbortSignal): PlaybookContext {
    const { store, bus, provider, providerFor, decisionService, sessionStateService } = this.deps;
    /** Keeps placeholder numbering unique across every field in this run. */
    let piiCounter = 0;

    /** Shared by ctx.callContext and runAgentTask's own internal provider calls. */
    const buildCallContext = (args: {
      stepId?: string;
      policyRule: string;
      redactions?: { placeholder: string; type: string }[];
    }): ProviderCallContext => ({
      runId,
      stepId: args.stepId,
      policyRule: args.policyRule,
      redactions: args.redactions,
      signal,
    });

    const createStep = async (spec: StepSpec): Promise<Step> => {
      const step = await store.appendStep({
        id: newId('step'),
        runId,
        nodeId: spec.nodeId,
        parentStepId: spec.parentStepId ?? null,
        kind: spec.kind ?? 'task',
        label: spec.label,
        status: 'running',
        providerId: spec.providerId,
        input: spec.input,
        startedAt: nowIso(),
      });
      await bus.emit(runId, { type: 'step.upserted', step });
      return step;
    };

    const judgeCheckpoint = async (
      checkpoint: SessionCheckpoint,
      stepId?: string,
    ): Promise<CompletionDecision> => {
      const decision = await decisionService.judgeCompletion(
        checkpoint,
        buildCallContext({ stepId, policyRule: 'verified-completion-checkpoint' }),
      );
      const fallback = decision.reasonCodes.some(
        (reason) => reason.includes('fallback') || reason.includes('deterministic'),
      );
      await bus.emit(runId, {
        type: 'control.decided',
        decision: {
          id: newId('ctl'),
          runId,
          stepId,
          operation: 'judge_completion',
          candidateIds: ['done', 'continue', 'blocked'],
          selectedIds: [decision.status],
          confidence: decision.confidence,
          reasonCodes: decision.reasonCodes,
          source: fallback ? 'fallback' : 'jev',
          at: nowIso(),
        },
      });
      return decision;
    };

    const ctx: PlaybookContext = {
      runId,
      signal,

      log: async (level, message) => {
        await bus.emit(runId, { type: 'log', runId, level, message, at: nowIso() });
      },

      step: async (spec, fn) => {
        const step = await createStep(spec);
        try {
          const output = await fn(step);
          await this.upsertStep(step.id, {
            status: 'succeeded',
            output: toJson(output),
            endedAt: nowIso(),
          });
          return output;
        } catch (err) {
          await this.upsertStep(step.id, {
            status: 'failed',
            error: { code: 'STEP_FAILED', message: (err as Error).message },
            endedAt: nowIso(),
          });
          throw err;
        }
      },

      fanOut: async <I, O>(spec: FanOutSpec<I, O>): Promise<FanOutOutcome<O>[]> => {
        const parent = await createStep({ label: spec.label, kind: 'swarm', nodeId: spec.nodeId });

        const outcomes = await fanOut<I, O>(
          spec.items,
          async (item, index) => {
            const child = await createStep({
              label: spec.workerLabel(item, index),
              kind: 'worker',
              // Same nodeId as the parent: the whole fan-out is one graph node.
              nodeId: spec.nodeId,
              parentStepId: parent.id,
            });
            try {
              const value = await spec.worker(item, index, child);
              await this.upsertStep(child.id, {
                status: 'succeeded',
                output: toJson(value),
                endedAt: nowIso(),
              });
              return value;
            } catch (err) {
              await this.upsertStep(child.id, {
                status: 'failed',
                error: { code: 'WORKER_FAILED', message: (err as Error).message },
                endedAt: nowIso(),
              });
              throw err;
            }
          },
          { concurrency: spec.concurrency, signal },
        );

        const failed = outcomes.filter((o) => !o.ok).length;
        // A partial swarm result is still useful, so the parent succeeds unless
        // every worker failed. Independent evidence, independently reported.
        await this.upsertStep(parent.id, {
          status: failed === outcomes.length && outcomes.length > 0 ? 'failed' : 'succeeded',
          output: { workers: outcomes.length, failed } as Json,
          endedAt: nowIso(),
        });
        return outcomes;
      },

      requireApproval: async (stepId: string, action: ProposedAction) => {
        const decision = classify(action);
        await this.upsertStep(stepId, { riskClass: decision.riskClass });

        if (decision.riskClass !== 'ask_human') return;

        const approval = {
          id: newId('apr'),
          runId,
          stepId,
          question: action.description,
          proposedAction: toJson(action.payload ?? action) ?? null,
          reversibility: decision.reversibility,
          riskClass: decision.riskClass,
          policyRule: decision.rule,
          status: 'pending' as const,
          createdAt: nowIso(),
        };

        await store.createApproval(approval);
        await this.upsertStep(stepId, { status: 'blocked', approvalId: approval.id });
        await this.patchRun(runId, { status: 'awaiting_approval' });
        await bus.emit(runId, { type: 'approval.requested', approval });

        // Blocks here. The decide endpoint patches the Approval, emits
        // approval.resolved, and calls settleApproval() to release this promise.
        const outcome = await waitForApproval(approval.id, signal);

        await this.patchRun(runId, { status: 'running' });
        await this.upsertStep(stepId, { status: 'running' });

        if (outcome === 'rejected') throw new ApprovalRejectedError(approval.id);
      },

      provider,
      providerFor,

      redact: async (text: string, field: string): Promise<RedactionOutput> => {
        const { redacted, spans } = detectPii(text, piiCounter);
        piiCounter += spans.length;

        for (const span of spans) {
          const stored = {
            id: newId('pii'),
            runId,
            type: span.type,
            placeholder: span.placeholder,
            field,
            // Sensitive values are pinned local. Only the placeholder may travel.
            routedTo: 'local' as const,
            value: span.value,
          };
          await store.appendPiiSpan(stored);
          // stripPiiValue is what keeps the raw value off the wire.
          await bus.emit(runId, { type: 'pii.detected', span: stripPiiValue(stored) });
        }

        return {
          redacted,
          redactions: spans.map((s) => ({ placeholder: s.placeholder, type: s.type })),
          hadSensitive: spans.length > 0,
        };
      },

      recordSchedule: async (input) => {
        const decision: ScheduleDecision = {
          id: newId('sch'),
          runId,
          privacy: input.privacy ?? 'cloud',
          intelligence: input.intelligence ?? 'low',
          privacyConfidence: input.privacyConfidence ?? input.confidence,
          intelligenceConfidence: input.intelligenceConfidence ?? input.confidence,
          escalated: false,
          at: nowIso(),
          ...input,
        };
        await store.createScheduleDecision(decision);
        await bus.emit(runId, { type: 'schedule.decided', decision });
        return decision;
      },

      callContext: buildCallContext,

      judgeCompletion: judgeCheckpoint,

      runAgentTask: async (spec: AgentTaskSpec): Promise<AgentTaskResult> => {
        const step = await createStep({
          label: spec.label,
          kind: 'agent_task',
          nodeId: spec.nodeId,
          parentStepId: spec.parentStepId ?? null,
          // Read from the registry rather than hardcoded, so re-pointing
          // 'agent.runtime' in BINDINGS relabels the step too.
          providerId: providerFor('agent.runtime'),
        });

        // 1.5s x 40 = 60s total budget. A real Hermes turn commonly takes
        // several seconds per model call and 40+ seconds for a slow tool call
        // (observed directly against a live install) — the old 400ms x 20
        // (~8s) default was sized for the mock and would cancel a real,
        // healthy call almost immediately.
        const pollIntervalMs = spec.pollIntervalMs ?? 1500;
        const maxPolls = spec.maxPolls ?? 40;
        const maxTurns = spec.maxTurns ?? 3;
        let sessionStateId: string | undefined;

        try {
          // 1. Search and normalize only task-relevant provider tools. Private
          //    objectives use an explicitly sanitized query; secret/local-only
          //    objectives never leave the machine for catalog discovery.
          const labels: DataLabel[] = spec.dataLabels ?? ['public'];
          const sanitizedTask =
            spec.sanitizedGoal ??
            (labels.every((label) => label === 'public') ? spec.goal : undefined);
          const remoteForbidden = labels.some(
            (label) => label === 'secret' || label === 'local_only',
          );
          const decisionState: DecisionState = {
            taskSummary: sanitizedTask ?? 'Sensitive objective withheld.',
            dataLabels: labels,
            sanitizedForRemote: Boolean(sanitizedTask) && !remoteForbidden,
          };

          const discoveredIds: string[] = [];
          if (this.deps.localToolCandidates) {
            discoveredIds.push(...(await this.deps.localToolCandidates()));
          }
          if (this.deps.toolDiscovery && sanitizedTask && !remoteForbidden) {
            const discovery = await this.deps.toolDiscovery.discoverForTask({
              query: sanitizedTask,
              runId,
              stepId: step.id,
              signal,
            });
            discoveredIds.push(...discovery.registered);
            if (discovery.warning) {
              await ctx.log('warn', 'Tool discovery failed closed: ' + discovery.warning);
            }
            if (discovery.skipped.length > 0) {
              await ctx.log(
                'info',
                'Skipped ' + discovery.skipped.length + ' unclassified provider tool(s).',
              );
            }
          } else if (this.deps.toolDiscovery && (!sanitizedTask || remoteForbidden)) {
            await ctx.log('info', 'Skipped remote tool discovery for sensitive task state.');
          }

          // Resolve all candidates through the trusted registry, then use Jev's
          // typed family/tool decisions before Hermes can start its inner loop.
          let availableTools = [...new Set([...spec.availableTools, ...discoveredIds])];
          let selectedBeforeLegacyRoute = availableTools;
          if (this.deps.toolRegistry) {
            const descriptors = eligibleTaskTools(
              await this.deps.toolRegistry.resolve(availableTools),
              decisionState,
            );
            availableTools = descriptors.map((descriptor) => descriptor.id);
            selectedBeforeLegacyRoute = await selectTaskTools(
              descriptors,
              decisionState,
              decisionService,
              buildCallContext({ stepId: step.id, policyRule: 'task-tool-selection' }),
              async (operation, candidateIds, selectedIds, confidence, reasonCodes) => {
                await bus.emit(runId, {
                  type: 'control.decided',
                  decision: {
                    id: newId('ctl'),
                    runId,
                    stepId: step.id,
                    operation,
                    candidateIds,
                    selectedIds,
                    confidence,
                    reasonCodes,
                    source: decisionSource(reasonCodes),
                    at: nowIso(),
                  },
                });
              },
            );
          }

          // The legacy route call still provides the coarse privacy/tier fields
          // used by ScheduleDecision. It can only narrow the already selected
          // registry IDs and is skipped for unsanitized remote state.
          const decider = provider('decision');
          const routed =
            decider.mode !== 'live' || decisionState.sanitizedForRemote
              ? await decider.route(
                  { task: decisionState.taskSummary, availableTools: selectedBeforeLegacyRoute },
                  buildCallContext({ stepId: step.id, policyRule: 'subtask-routing' }),
                )
              : null;

          // FAIL CLOSED, not open — docs/agentos-design.md is explicit:
          // "Routing... failures fail closed; failure never exposes all
          // tools." A Jev outage must narrow what the harness can touch, not
          // widen it. The task still runs (as a tool-less LLM turn) rather
          // than aborting outright — that's a judgment call, not a spec
          // requirement, and worth revisiting if it turns out to be wrong.
          const routeResult = routed?.ok
            ? {
                ...routed.data,
                exposedTools: routed.data.exposedTools.filter((toolId) =>
                  selectedBeforeLegacyRoute.includes(toolId),
                ),
              }
            : {
                privacy: 'private' as const,
                intelligence: 'high' as const,
                privacyConfidence: 0,
                intelligenceConfidence: 0,
                modelTier: 'local' as const,
                exposedTools: [],
                confidence: 0,
                rationale:
                  (routed
                    ? 'Routing failed (' + routed.error.code + ')'
                    : 'Remote routing was ineligible for unsanitized state') +
                  '; using safe local execution with no tools.',
              };

          const decision: ScheduleDecision = {
            id: newId('sch'),
            runId,
            stepId: step.id,
            requestedCapability: 'agent.runtime',
            selectedProvider: providerFor('agent.runtime'),
            privacy: routeResult.privacy,
            intelligence: routeResult.intelligence,
            privacyConfidence: routeResult.privacyConfidence,
            intelligenceConfidence: routeResult.intelligenceConfidence,
            modelTier: routeResult.modelTier,
            availableTools,
            exposedTools: routeResult.exposedTools,
            confidence: routeResult.confidence,
            escalated: false,
            rule: routed?.ok ? 'jev-routed' : 'route-failed-safe-local',
            at: nowIso(),
          };
          await store.createScheduleDecision(decision);
          await bus.emit(runId, { type: 'schedule.decided', decision });

          // 2. Register AgentOS's canonical state BEFORE Hermes can make its
          // first model request. The model gateway resolves this active record
          // and never treats Hermes's internal transcript as canonical state.
          const sessionState = await sessionStateService.create({
            runId,
            stepId: step.id,
            harness: 'hermes',
            objective: spec.goal,
            sanitizedObjective:
              spec.sanitizedGoal ??
              (labels.every((label) => label === 'public') ? spec.goal : undefined),
            dataLabels: labels,
            budget: { stepsRemaining: maxTurns },
            candidateToolIds: decision.exposedTools,
          });
          sessionStateId = sessionState.id;
          await sessionStateService.beginTurn(sessionState.id);

          // 3. Start the task with ONLY the tools Jev exposed.
          const runtime = provider('agent.runtime');
          const started = await runtime.startTask(
            { goal: spec.goal, context: spec.context, tools: decision.exposedTools },
            buildCallContext({ stepId: step.id, policyRule: 'jev-filtered-toolset' }),
          );
          if (!started.ok) throw new Error('Failed to start agent task: ' + started.error.message);
          const taskId = started.data.taskId;
          await sessionStateService.bindHarnessSession(sessionState.id, taskId);

          await bus.emit(runId, {
            type: 'harness.turn',
            turn: {
              id: newId('turn'),
              runId,
              sessionId: taskId,
              turnId: taskId + ':1',
              phase: 'started',
              at: nowIso(),
            },
          });

          // 4. AgentOS owns the bounded outer loop. Hermes owns each inner turn.
          let toolCalls: { tool: string; args?: unknown; at: string }[] = [];
          let finalResult: unknown = null;
          let completed = false;
          let completionDecision: CompletionDecision | null = null;
          const requiresToolAction = requiresExternalAction(spec.goal);

          for (let turn = 1; turn <= maxTurns; turn += 1) {
            let turnCompleted = false;
            let turnToolCalls: { tool: string; args?: unknown; at: string }[] = [];
            let pollAttempts = 0;
            while (pollAttempts < maxPolls) {
              if (signal.aborted) throw new Error('Run aborted while awaiting agent task');

              const polled = await runtime.pollTask(
                taskId,
                buildCallContext({ stepId: step.id, policyRule: 'jev-filtered-toolset' }),
              );
              if (!polled.ok) throw new Error('Agent task polling failed: ' + polled.error.message);
              if (polled.data.status === 'failed')
                throw new Error('Agent task ' + taskId + ' failed');

              if (polled.data.status === 'done') {
                finalResult = polled.data.result ?? null;
                turnToolCalls = polled.data.toolCalls ?? [];
                toolCalls.push(...turnToolCalls);
                turnCompleted = true;
                break;
              }
              const currentRun = await store.getRun(runId);
              // Human review time is not harness execution time. Keep polling
              // while the exact action is awaiting approval without consuming
              // the bounded Hermes poll budget.
              if (currentRun?.status !== 'awaiting_approval') pollAttempts += 1;
              await sleep(pollIntervalMs);
            }

            if (!turnCompleted) break;

            await bus.emit(runId, {
              type: 'harness.turn',
              turn: {
                id: newId('turn'),
                runId,
                sessionId: taskId,
                turnId: taskId + ':' + turn,
                phase: 'quiescent',
                payload: toJson({ toolCallCount: turnToolCalls.length }),
                at: nowIso(),
              },
            });

            const hasResult = finalResult !== null && finalResult !== undefined;
            // Harness tool-result messages include provider errors as well as
            // successes. Only the broker's authoritative lifecycle event proves
            // that the exact action passed policy, approval, execution, and
            // verification; never infer success from a role=tool transcript entry.
            const hasSuccessfulToolResult = (await store.eventsSince(runId, 0)).some(
              ({ event }) =>
                event.type === 'tool.lifecycle' &&
                event.lifecycle.stepId === step.id &&
                event.lifecycle.phase === 'succeeded',
            );
            const verifiedOutcome = hasResult && (!requiresToolAction || hasSuccessfulToolResult);
            const outstandingRequirements = [
              ...(!hasResult ? ['agent-result-missing'] : []),
              ...(requiresToolAction && !hasSuccessfulToolResult
                ? ['required-tool-action-not-completed']
                : []),
            ];
            const checkpoint: SessionCheckpoint = {
              runId,
              objective: spec.goal,
              sanitizedObjective:
                spec.sanitizedGoal ??
                (labels.every((label) => label === 'public') ? spec.goal : undefined),
              steps: [
                {
                  id: step.id + ':turn:' + turn,
                  label: spec.label + ' turn ' + turn,
                  status: 'succeeded',
                  required: true,
                  sanitizedSummary: hasResult
                    ? 'Hermes produced a result for the requested objective.'
                    : 'Harness produced no result.',
                },
              ],
              artifacts: [
                {
                  id: step.id + ':result',
                  kind: 'harness_result',
                  required: true,
                  verified: verifiedOutcome,
                  dataLabels: labels,
                  sanitizedSummary: verifiedOutcome
                    ? 'The required harness result and tool action are present and verified.'
                    : undefined,
                },
              ],
              verifications: [
                {
                  id: step.id + ':result-present',
                  passed: hasResult,
                  required: true,
                  reasonCode: hasResult ? 'result-present' : 'result-missing',
                },
                ...(requiresToolAction
                  ? [
                      {
                        id: step.id + ':tool-action-completed',
                        passed: hasSuccessfulToolResult,
                        required: true,
                        reasonCode: hasSuccessfulToolResult
                          ? 'required-tool-action-completed'
                          : 'required-tool-action-not-completed',
                      },
                    ]
                  : []),
              ],
              outstandingRequirements,
              pendingApprovalIds: [],
              dataLabels: labels,
              budget: { stepsRemaining: Math.max(0, maxTurns - turn) },
              at: nowIso(),
            };
            await sessionStateService.checkpoint(sessionState.id, checkpoint);
            completionDecision = await judgeCheckpoint(checkpoint, step.id);

            if (completionDecision.status === 'done' && completionDecision.verified) {
              completed = true;
              await sessionStateService.setStatus(sessionState.id, 'completed');
              break;
            }
            if (completionDecision.status === 'blocked') {
              await sessionStateService.setStatus(sessionState.id, 'blocked');
              throw new Error(
                'Agent task blocked: ' +
                  (completionDecision.verificationFailures.join(', ') ||
                    completionDecision.reasonCodes.join(', ')),
              );
            }
            if (turn < maxTurns) {
              await sessionStateService.beginTurn(sessionState.id);
              const continued = await runtime.continueTask(
                taskId,
                {
                  instruction:
                    'Continue working toward the original objective. You must use an available tool when the objective requests an external action; do not claim completion until the tool succeeds. Resolve every missing verification before stopping.',
                  context: { previousResultPresent: hasResult },
                },
                buildCallContext({ stepId: step.id, policyRule: 'bounded-agent-continuation' }),
              );
              if (!continued.ok) {
                throw new Error('Failed to continue agent task: ' + continued.error.message);
              }
              await bus.emit(runId, {
                type: 'harness.turn',
                turn: {
                  id: newId('turn'),
                  runId,
                  sessionId: taskId,
                  turnId: taskId + ':' + (turn + 1),
                  phase: 'started',
                  at: nowIso(),
                },
              });
            }
          }

          if (!completed || !completionDecision) {
            await sessionStateService.setStatus(sessionState.id, 'blocked');
            await runtime.cancelTask(
              taskId,
              buildCallContext({ stepId: step.id, policyRule: 'outer-loop-budget-cancel' }),
            );
            throw new Error(
              'Agent task ' + taskId + ' did not reach verified completion within its budget',
            );
          }

          await runtime.cancelTask(
            taskId,
            buildCallContext({ stepId: step.id, policyRule: 'completed-session-close' }),
          );

          // 5. Post-hoc audit. The runtime ran its own loop internally, so this
          //    is our only visibility into what it touched — recorded into the
          //    SAME ledger real provider calls go through, so "every outbound
          //    call is logged" still holds, just after the fact rather than
          //    gated in real time.
          for (const call of toolCalls) {
            const egress = buildEgressEvent(
              {
                id: newId('egr'),
                runId,
                stepId: step.id,
                providerId: 'hermes',
                op: 'internal.tool_call:' + call.tool,
                destination: 'hermes-internal://' + call.tool,
                policyRule: 'reported-post-hoc-by-hermes',
              },
              call.at,
            );
            await store.appendEgress(egress);
            await bus.emit(runId, { type: 'egress.logged', egress });
          }

          await this.upsertStep(step.id, {
            status: 'succeeded',
            output: toJson({
              result: finalResult,
              toolCallCount: toolCalls.length,
              toolCalls,
              completionDecision,
            }),
            endedAt: nowIso(),
          });

          return { result: finalResult, scheduleDecision: decision, toolCalls, completionDecision };
        } catch (err) {
          if (sessionStateId) {
            const state = await sessionStateService.get(sessionStateId);
            if (state && !['completed', 'blocked', 'cancelled'].includes(state.status)) {
              await sessionStateService.setStatus(
                sessionStateId,
                signal.aborted ? 'cancelled' : 'failed',
              );
            }
          }
          await this.upsertStep(step.id, {
            status: 'failed',
            error: { code: 'AGENT_TASK_FAILED', message: (err as Error).message },
            endedAt: nowIso(),
          });
          throw err;
        }
      },
    };

    return ctx;
  }
}

function eligibleTaskTools(descriptors: ToolDescriptor[], state: DecisionState): ToolDescriptor[] {
  return descriptors.filter(
    (descriptor) =>
      descriptor.availability === 'available' &&
      descriptor.baselineEffect !== 'unknown' &&
      descriptor.simulated !== true &&
      state.dataLabels.every((label) => descriptor.allowedDataLabels.includes(label)),
  );
}

function requiresExternalAction(goal: string): boolean {
  return /^(?:please\s+)?(?:send|email|message|reply|forward|post|publish|submit|create|update|delete|remove|invite|schedule|book|purchase|pay|transfer)\b/i.test(
    goal.trim(),
  );
}

async function selectTaskTools(
  descriptors: ToolDescriptor[],
  state: DecisionState,
  decisions: DecisionService,
  ctx: ProviderCallContext,
  emit: (
    operation: ControlDecisionOperation,
    candidateIds: string[],
    selectedIds: string[],
    confidence: number,
    reasonCodes: string[],
  ) => Promise<void>,
): Promise<string[]> {
  const families = [...new Set(descriptors.map((descriptor) => descriptor.family))];
  const familyDecision = await decisions.selectToolFamilies(state, families, ctx);
  await emit(
    'select_tool_families',
    families,
    familyDecision.selectedFamilies,
    average(Object.values(familyDecision.confidences)),
    familyDecision.reasonCodes,
  );
  const selectedFamilies = new Set(familyDecision.selectedFamilies);
  const narrowed = descriptors.filter((descriptor) => selectedFamilies.has(descriptor.family));
  const toolDecision = await decisions.selectTools(state, narrowed, ctx);
  await emit(
    'select_tools',
    narrowed.map((descriptor) => descriptor.id),
    toolDecision.selectedToolIds,
    average(Object.values(toolDecision.confidences)),
    toolDecision.reasonCodes,
  );
  const selectedIds = new Set(toolDecision.selectedToolIds);
  return narrowed.filter((descriptor) => selectedIds.has(descriptor.id)).map((tool) => tool.id);
}

function average(values: number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function decisionSource(reasonCodes: string[]): 'jev' | 'deterministic' | 'fallback' {
  if (reasonCodes.some((reason) => reason.includes('fallback') || reason.includes('fail-closed'))) {
    return 'fallback';
  }
  if (reasonCodes.some((reason) => reason.includes('deterministic') || reason.startsWith('no-'))) {
    return 'deterministic';
  }
  return 'jev';
}

/** Best-effort conversion to a storable Json value. Never throws. */
function toJson(value: unknown): Json | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as Json;
  } catch {
    return String(value);
  }
}
