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
  Json,
  ProposedAction,
  ProviderCallContext,
  Run,
  ScheduleDecision,
  Step,
} from '@htn/shared';
import { stripPiiValue } from '@htn/shared';
import type { Store } from '../store/types.js';
import { newId, nowIso } from '../lib/ids.js';
import { ApprovalRejectedError, waitForApproval } from './approvalGate.js';
import type { RunBus } from './bus.js';
import { buildEgressEvent } from './ledger.js';
import { detectPii } from './redaction.js';
import { classify } from './risk.js';
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
    const { store, bus, provider } = this.deps;
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
        const parent = await createStep({ label: spec.label, kind: 'swarm' });

        const outcomes = await fanOut<I, O>(
          spec.items,
          async (item, index) => {
            const child = await createStep({
              label: spec.workerLabel(item, index),
              kind: 'worker',
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

      callContext: buildCallContext,

      runAgentTask: async (spec: AgentTaskSpec): Promise<AgentTaskResult> => {
        const step = await createStep({
          label: spec.label,
          kind: 'agent_task',
          parentStepId: spec.parentStepId ?? null,
          // Hardcoded rather than read from the registry's actual binding —
          // correct today ('agent.runtime' -> hermes) but worth revisiting if
          // that binding ever becomes dynamic per call.
          providerId: 'hermes',
        });

        const pollIntervalMs = spec.pollIntervalMs ?? 400;
        const maxPolls = spec.maxPolls ?? 20;

        try {
          // 1. Route BEFORE starting the task. This is where tool/model
          //    optimization actually happens — see AgentTaskSpec's doc comment
          //    for why it's subtask-granularity, not per-turn.
          const decider = provider('decision');
          const routed = await decider.route(
            { task: spec.goal, availableTools: spec.availableTools },
            buildCallContext({ stepId: step.id, policyRule: 'subtask-routing' }),
          );

          const routeResult = routed.ok
            ? routed.data
            : {
                modelTier: 'standard' as const,
                exposedTools: spec.availableTools,
                confidence: 0,
                rationale: 'Routing failed (' + routed.error.code + '); using the full tool list.',
              };

          const decision: ScheduleDecision = {
            id: newId('sch'),
            runId,
            stepId: step.id,
            requestedCapability: 'agent.runtime',
            selectedProvider: 'hermes',
            modelTier: routeResult.modelTier,
            availableTools: spec.availableTools,
            exposedTools: routeResult.exposedTools,
            confidence: routeResult.confidence,
            escalated: false,
            rule: routed.ok ? 'jev-routed' : 'route-failed-fallback-full-toolset',
            at: nowIso(),
          };
          await store.createScheduleDecision(decision);
          await bus.emit(runId, { type: 'schedule.decided', decision });

          // 2. Start the task with ONLY the tools Jev exposed.
          const runtime = provider('agent.runtime');
          const started = await runtime.startTask(
            { goal: spec.goal, context: spec.context, tools: decision.exposedTools },
            buildCallContext({ stepId: step.id, policyRule: 'jev-filtered-toolset' }),
          );
          if (!started.ok) throw new Error('Failed to start agent task: ' + started.error.message);
          const taskId = started.data.taskId;

          // 3. Poll to completion, bounded so a stuck task cannot hang the run.
          let toolCalls: { tool: string; args?: unknown; at: string }[] = [];
          let finalResult: unknown = null;
          let completed = false;

          for (let attempt = 0; attempt < maxPolls; attempt += 1) {
            if (signal.aborted) throw new Error('Run aborted while awaiting agent task');

            const polled = await runtime.pollTask(
              taskId,
              buildCallContext({ stepId: step.id, policyRule: 'jev-filtered-toolset' }),
            );
            if (!polled.ok) throw new Error('Agent task polling failed: ' + polled.error.message);
            if (polled.data.status === 'failed') throw new Error('Agent task ' + taskId + ' failed');

            if (polled.data.status === 'done') {
              finalResult = polled.data.result ?? null;
              toolCalls = polled.data.toolCalls ?? [];
              completed = true;
              break;
            }
            await sleep(pollIntervalMs);
          }

          if (!completed) {
            await runtime.cancelTask(
              taskId,
              buildCallContext({ stepId: step.id, policyRule: 'poll-timeout-cancel' }),
            );
            throw new Error('Agent task ' + taskId + ' did not complete within ' + maxPolls + ' polls');
          }

          // 4. Post-hoc audit. The runtime ran its own loop internally, so this
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
            output: toJson({ result: finalResult, toolCallCount: toolCalls.length, toolCalls }),
            endedAt: nowIso(),
          });

          return { result: finalResult, scheduleDecision: decision, toolCalls };
        } catch (err) {
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

/** Best-effort conversion to a storable Json value. Never throws. */
function toJson(value: unknown): Json | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as Json;
  } catch {
    return String(value);
  }
}
