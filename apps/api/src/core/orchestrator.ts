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
  HarnessToolCall,
  Json,
  ProposedAction,
  ProviderCallContext,
  ProviderId,
  Run,
  ScheduleDecision,
  Step,
} from '@htn/shared';
import { stripPiiValue } from '@htn/shared';
import type { Store } from '../store/types.js';
import { newId, nowIso } from '../lib/ids.js';
import { ApprovalRejectedError, waitForApproval, type ApprovalOutcome } from './approvalGate.js';
import { registerRunContext, releaseRunContext } from './runContexts.js';
import type { RunBus } from './bus.js';
import * as runGate from './runGate.js';
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
  /** Reads the registry's live BINDINGS, so a re-point is reflected everywhere. */
  providerFor: (capability: Capability) => ProviderId;
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
   * Ask a run to pause: block new work, let whatever is already running
   * finish. See core/runGate.ts for the full model. Returns the updated Run,
   * or null if this process is not actually executing it (already terminal,
   * or running in a different process/before a restart).
   *
   * Idempotent: pausing an already-pausing or already-paused run is a no-op
   * that returns the current Run unchanged.
   */
  async pause(runId: string): Promise<Run | null> {
    if (!this.inFlight.has(runId)) return null;
    const before = await this.deps.store.getRun(runId);
    if (!before) return null;
    if (before.control === 'pausing' || before.control === 'paused') return before;

    await this.patchRun(runId, { control: 'pausing' });
    await runGate.requestPause(runId);

    // A concurrent resume() can win this race (see runGate.requestPause's own
    // note) -- if so, resumeRun() already patched control back to 'running',
    // and pausing now would silently re-pause a run the operator just resumed.
    if (runGate.stateOf(runId) !== 'paused') return this.deps.store.getRun(runId);

    const current = await this.deps.store.getRun(runId);
    return this.patchRun(runId, {
      control: 'paused',
      pauses: [...(current?.pauses ?? []), { at: nowIso() }],
    });
  }

  /**
   * Resume a paused (or still-draining) run. No-op if it is not paused.
   * Closes the most recent open PauseSpan so analytics can exclude exactly
   * the time actually spent idle -- not the "pausing" drain, which was real
   * work finishing, and not time after a race where pause never completed.
   */
  async resumeRun(runId: string): Promise<Run | null> {
    if (!this.inFlight.has(runId)) return null;
    const current = await this.deps.store.getRun(runId);
    if (!current) return null;
    if (current.control === undefined || current.control === 'running') return current;

    const pauses = current.pauses ?? [];
    const lastIndex = pauses.length - 1;
    const closed =
      lastIndex >= 0 && !pauses[lastIndex]?.resumedAt
        ? pauses.map((pause, i) => (i === lastIndex ? { ...pause, resumedAt: nowIso() } : pause))
        : pauses;

    const run = await this.patchRun(runId, { control: 'running', pauses: closed });
    // Order matters: patch the durable record first, THEN release waiters --
    // a checkpoint() that wakes up and immediately re-reads run state (it
    // does not today, but a future caller might) must see 'running' already.
    runGate.resume(runId);
    return run;
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
      registerRunContext(run.id, ctx);
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
      releaseRunContext(run.id);
      runGate.dispose(run.id);
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
    const { store, bus, provider, providerFor } = this.deps;
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

    const ctx: PlaybookContext = {
      runId,
      signal,

      log: async (level, message) => {
        await bus.emit(runId, { type: 'log', runId, level, message, at: nowIso() });
      },

      step: async (spec, fn) => {
        // A new step is exactly the "new work" a pause must not let start.
        // Whatever is already running is untouched -- see core/runGate.ts.
        await runGate.checkpoint(runId, signal);
        const step = await createStep(spec);
        try {
          const output = await runGate.track(runId, () => fn(step));
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
        await runGate.checkpoint(runId, signal);
        const parent = await createStep({ label: spec.label, kind: 'swarm', nodeId: spec.nodeId });

        const outcomes = await fanOut<I, O>(
          spec.items,
          async (item, index) => {
            // Checked per worker, not once before the whole fan-out: a pause
            // requested mid-swarm must stop handing out NEW items while the
            // ones already in flight run to completion (bounded concurrency
            // means not every item has started yet when pause is requested).
            await runGate.checkpoint(runId, signal);
            const child = await createStep({
              label: spec.workerLabel(item, index),
              kind: 'worker',
              // Same nodeId as the parent: the whole fan-out is one graph node.
              nodeId: spec.nodeId,
              parentStepId: parent.id,
            });
            try {
              const value = await runGate.track(runId, () => spec.worker(item, index, child));
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

        // NOT in-flight work while a human reads this: nothing is running,
        // so a pause can fully drain (reach 'paused') even with an approval
        // still pending. release()/reacquire() bracket exactly the wait, so
        // the enclosing ctx.step's own track() -- which is still "in flight"
        // for as long as this whole requireApproval call takes -- ends up
        // balanced regardless of how long the human takes to answer.
        runGate.release(runId);
        let outcome: ApprovalOutcome;
        try {
          // Blocks here. The decide endpoint patches the Approval, emits
          // approval.resolved, and calls settleApproval() to release this promise.
          outcome = await waitForApproval(approval.id, signal);
        } finally {
          runGate.reacquire(runId);
        }

        // Approved: before resuming, honour a pause requested while we were
        // waiting on the human. Not checked on rejection -- that unwinds the
        // whole run via the throw below regardless of pause state, so there
        // is nothing left to hold open for.
        if (outcome !== 'rejected') {
          await runGate.checkpoint(runId, signal);
        }

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

      runAgentTask: async (spec: AgentTaskSpec): Promise<AgentTaskResult> => {
        await runGate.checkpoint(runId, signal);
        const step = await createStep({
          label: spec.label,
          kind: 'agent_task',
          nodeId: spec.nodeId,
          parentStepId: spec.parentStepId ?? null,
          // Read from the registry rather than hardcoded, so re-pointing
          // 'agent.runtime' in BINDINGS relabels the step too.
          providerId: providerFor('agent.runtime'),
        });

        // TWO SEPARATE BUDGETS, not one:
        //
        //   maxPolls           absolute safety ceiling. 1.5s x 400 ~= 10 min.
        //                      This almost never fires — see below.
        //   inactivityTimeoutMs  the one that actually ends a stuck task. A
        //                      harness that keeps reporting fresh activity
        //                      (see AgentRuntimeAdapter.pollTask.lastActivityAt)
        //                      is left running regardless of total elapsed
        //                      time; one that goes silent is cut off long
        //                      before the absolute ceiling.
        //
        // Previously this was a single 1.5s x 40 (~60s) poll-count cutoff,
        // which killed a real, healthy-but-slow Hermes task (several seconds
        // per model call, 40+ seconds observed for a single slow tool call)
        // at the exact same moment it would have killed one that was
        // genuinely hung — there was no way to tell the two apart from the
        // terminal. A harness that cannot report lastActivityAt (see the mock,
        // or a future non-Hermes adapter) falls back to maxPolls alone,
        // unchanged from before.
        const pollIntervalMs = spec.pollIntervalMs ?? 1500;
        const maxPolls = spec.maxPolls ?? 400;
        const inactivityTimeoutMs = spec.inactivityTimeoutMs ?? 120_000;
        // THE THIRD BUDGET, and in practice the one that fires. See
        // AgentTaskSpec.maxDurationMs: measured against live Hermes, the idle
        // clock never passed 17s during a 196s task because the harness
        // streams thought chunks the whole time it reasons, so
        // inactivityTimeoutMs cannot distinguish "converging slowly" from
        // "looping uselessly" and only maxPolls (600s) ever stopped anything.
        const maxDurationMs = spec.maxDurationMs ?? 240_000;
        // Not a clock. See AgentTaskSpec.maxFailedToolCalls: a harness with
        // broken tools stays busy, so every time-based budget above lets it
        // run to the end. This is the one that catches "it cannot actually
        // do this" rather than "it is taking a while".
        const maxFailedToolCalls = spec.maxFailedToolCalls ?? 3;

        /**
         * Write the harness's self-reported tool calls into the SAME ledger
         * real provider calls go through.
         *
         * Called on BOTH the success and the failure path. It used to run only
         * on success, which quietly broke the ledger's own invariant: a task
         * killed by a timeout had genuinely made those calls -- they left the
         * machine -- and none of them were ever recorded. A timeout is exactly
         * when you most want the list.
         */
        const ledgerToolCalls = async (
          calls: HarnessToolCall[],
        ): Promise<void> => {
          for (const call of calls) {
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
        };

        /**
         * Tool calls seen so far, updated on every poll. Declared out here so
         * the catch block below can still report them after a throw.
         */
        let toolCalls: HarnessToolCall[] = [];

        // The WHOLE task -- routing through the poll loop through the audit --
        // is one unit of in-flight work. A pause waits for it to finish
        // rather than cutting it off mid-turn; see this file's header for
        // why (a Hermes cancel cannot resume the same turn, and the wait is
        // already bounded by this task's own time/failure budgets).
        return runGate.track(runId, async () => {
        try {
          // 1. Route BEFORE starting the task. This is where tool/model
          //    optimization actually happens — see AgentTaskSpec's doc comment
          //    for why it's subtask-granularity, not per-turn.
          const decider = provider('decision');
          const routed = await decider.route(
            { task: spec.goal, availableTools: spec.availableTools },
            buildCallContext({ stepId: step.id, policyRule: 'subtask-routing' }),
          );

          // FAIL CLOSED, not open — docs/agentos-design.md is explicit:
          // "Routing... failures fail closed; failure never exposes all
          // tools." A Jev outage must narrow what the harness can touch, not
          // widen it. The task still runs (as a tool-less LLM turn) rather
          // than aborting outright — that's a judgment call, not a spec
          // requirement, and worth revisiting if it turns out to be wrong.
          const routeResult = routed.ok
            ? routed.data
            : {
                privacy: 'private' as const,
                intelligence: 'high' as const,
                privacyConfidence: 0,
                intelligenceConfidence: 0,
                modelTier: 'local' as const,
                exposedTools: [],
                confidence: 0,
                rationale:
                  'Routing failed (' +
                  routed.error.code +
                  '); using safe local execution with no tools.',
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
            availableTools: spec.availableTools,
            exposedTools: routeResult.exposedTools,
            confidence: routeResult.confidence,
            escalated: false,
            rule: routed.ok ? 'jev-routed' : 'route-failed-safe-local',
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
          let finalResult: unknown = null;
          let completed = false;
          let stopReason: 'inactive' | 'max_polls' | 'max_duration' | 'tool_failures' | null =
            null;

          const pollingStartedAt = Date.now();
          // Anchors the inactivity clock until the harness reports its own
          // lastActivityAt (see below) — without this, a harness that DOES
          // report activity but hasn't sent its first update yet would look
          // "inactive since forever" on attempt 0 and time out instantly.
          let lastKnownActivityAt = pollingStartedAt;

          for (let attempt = 0; attempt < maxPolls; attempt += 1) {
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
              toolCalls = polled.data.toolCalls ?? [];
              completed = true;
              break;
            }

            // Keep the latest self-reported tool calls from EVERY poll, not
            // just the terminal one. A task that is later cancelled by a
            // timeout still has to be able to say what it invoked before it
            // was stopped -- that list is the main evidence for WHY it stalled
            // (e.g. "21 web searches, no browser") and it is exactly what was
            // being thrown away when the run failed.
            if (polled.data.toolCalls) toolCalls = polled.data.toolCalls;

            if (polled.data.lastActivityAt) {
              lastKnownActivityAt = Date.parse(polled.data.lastActivityAt);
            }
            const elapsedMs = Date.now() - pollingStartedAt;
            const idleMs = Date.now() - lastKnownActivityAt;

            // Terminal visibility into the poll loop itself, independent of
            // whatever the harness adapter logs on its own side (Hermes's
            // live adapter logs its own detailed line per poll too — this one
            // is what the ORCHESTRATOR sees and is deciding on).
            console.log(
              '[agent_task]',
              step.id,
              'poll ' + (attempt + 1) + '/' + maxPolls,
              '| elapsed=' + (elapsedMs / 1000).toFixed(1) + 's',
              '| idle=' + (idleMs / 1000).toFixed(1) + 's',
              '| toolCalls=' + (polled.data.toolCalls?.length ?? 0),
            );

            // Checked BEFORE the time budgets: when a task is doomed because
            // its tools are broken, the useful error names the tools, not the
            // clock. Letting a timeout win the race here would bury the
            // actual cause under a generic "took too long".
            const failedCalls = toolCalls.filter((c) => c.status === 'failed');
            if (maxFailedToolCalls > 0 && failedCalls.length >= maxFailedToolCalls) {
              stopReason = 'tool_failures';
              break;
            }

            if (idleMs >= inactivityTimeoutMs) {
              stopReason = 'inactive';
              break;
            }
            if (elapsedMs >= maxDurationMs) {
              stopReason = 'max_duration';
              break;
            }

            await sleep(pollIntervalMs);
          }

          if (!completed) {
            stopReason ??= 'max_polls';
            await runtime.cancelTask(
              taskId,
              buildCallContext({ stepId: step.id, policyRule: 'poll-timeout-cancel' }),
            );
            if (stopReason === 'tool_failures') {
              const failed = toolCalls.filter((c) => c.status === 'failed');
              // Name the tool AND what it said. "3 tool calls failed" sends
              // someone back to the logs; "browser_exec failed: daemon didn't
              // come up" is something they can act on without leaving here.
              const detail = failed
                .map((c) => '  • ' + c.tool + (c.result ? ' -> ' + c.result : ''))
                .join('\n');
              throw new Error(
                'Agent task ' +
                  taskId +
                  ' was stopped after ' +
                  failed.length +
                  ' tool call(s) in a row failed (of ' +
                  toolCalls.length +
                  ' total) — it was working, but not with tools that work:\n' +
                  detail +
                  '\nFix the tool (or stop offering it to this task) rather than raising the ' +
                  'time budget; more time only buys more failed retries. Raise ' +
                  'maxFailedToolCalls on this node if these failures are expected and recoverable.',
              );
            }
            if (stopReason === 'max_duration') {
              throw new Error(
                'Agent task ' +
                  taskId +
                  ' was still active but had not finished after ' +
                  (maxDurationMs / 1000).toFixed(0) +
                  's (its wall-clock budget), so it was stopped. It was NOT idle — ' +
                  'the harness kept reporting activity throughout. Either the goal is too ' +
                  'open-ended for one agent turn, or the harness lacks a tool it needs and is ' +
                  'working around it slowly. Check the [hermes:live] tool_call lines for this ' +
                  'task to see what it actually spent the time on, and raise maxDurationMs on ' +
                  'this node only if the work genuinely takes this long.',
              );
            }
            throw new Error(
              stopReason === 'inactive'
                ? 'Agent task ' +
                    taskId +
                    ' produced no activity for ' +
                    (inactivityTimeoutMs / 1000).toFixed(0) +
                    's and was treated as stuck (' +
                    ((Date.now() - pollingStartedAt) / 1000).toFixed(0) +
                    's total). Check the terminal for [hermes:live] logs around this task — ' +
                    'an "unhandled update kind" line there means Hermes was actually active but ' +
                    'sending something this adapter did not recognise, not that it was truly idle.'
                : 'Agent task ' +
                    taskId +
                    ' did not complete within ' +
                    maxPolls +
                    ' polls (' +
                    ((Date.now() - pollingStartedAt) / 1000).toFixed(0) +
                    's) despite ongoing activity — raise maxPolls if this task is legitimately ' +
                    'this long-running, or investigate why it never converges.',
            );
          }

          // 4. Post-hoc audit. The runtime ran its own loop internally, so this
          //    is our only visibility into what it touched — recorded into the
          //    SAME ledger real provider calls go through, so "every outbound
          //    call is logged" still holds, just after the fact rather than
          //    gated in real time.
          await ledgerToolCalls(toolCalls);

          await this.upsertStep(step.id, {
            status: 'succeeded',
            output: toJson({ result: finalResult, toolCallCount: toolCalls.length, toolCalls }),
            endedAt: nowIso(),
          });

          return { result: finalResult, scheduleDecision: decision, toolCalls };
        } catch (err) {
          // Preserve the evidence. A failed agent task used to write ONLY an
          // error string, so the timeline could say "this timed out" but never
          // "...after calling web_search 21 times" -- the single most useful
          // fact for working out why. Both the step output and the ledger now
          // carry whatever the harness reported before it was stopped.
          await ledgerToolCalls(toolCalls);
          await this.upsertStep(step.id, {
            status: 'failed',
            error: { code: 'AGENT_TASK_FAILED', message: (err as Error).message },
            output: toJson({ partial: true, toolCallCount: toolCalls.length, toolCalls }),
            endedAt: nowIso(),
          });
          throw err;
        }
        });
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
