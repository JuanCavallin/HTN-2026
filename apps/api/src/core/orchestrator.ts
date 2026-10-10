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
  ToolboxToolkitDefinition,
} from '@htn/shared';
import { stripPiiValue } from '@htn/shared';
import type { Store } from '../store/types.js';
import { newId, nowIso } from '../lib/ids.js';
import { ApprovalRejectedError, waitForApproval } from './approvalGate.js';
import type { RunBus } from './bus.js';
import { buildEgressEvent } from './ledger.js';
import { modelCompletionEvidence } from './modelGateway/evidence.js';
import { clearPause, pauseRun, waitWhilePaused } from './pauseGate.js';
import { detectPii } from './redaction.js';
import { classify } from './risk.js';
import type { DecisionService } from './decisions/service.js';
import type { SessionStateService } from './sessions/service.js';
import type { ToolRegistry } from './tools/registry.js';
import {
  buildToolShortlist,
  inferToolIntent,
  selectToolsForTask,
  shortlistConnectedToolkits,
  type ToolIntent,
} from './tools/selection.js';
import { verifiedReadShortcut } from './tools/readShortcut.js';
import { weatherArgumentsForTask } from './tools/weather.js';
import { webSearchArgumentsForTask } from './tools/webSearch.js';
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
  /** The trusted broker. Absent means graph tool nodes have no brokered path. */
  toolBroker?: {
    execute(request: {
      sessionStateId: string;
      toolId: string;
      arguments: Json;
      signal?: AbortSignal;
    }): Promise<{ output: Json; summary: string; verified?: boolean }>;
  };
  toolDiscovery?: {
    connectedToolkits(input: {
      runId: string;
      stepId?: string;
      signal?: AbortSignal;
    }): Promise<{ toolkits: ToolboxToolkitDefinition[]; warning?: string }>;
    importToolkits(input: {
      toolkits: string[];
      runId: string;
      stepId?: string;
      signal?: AbortSignal;
    }): Promise<{ registered: string[]; skipped: string[]; warning?: string }>;
    /** Retained for the manual catalog-preview endpoint, not agent routing. */
    discoverForTask(input: {
      query: string;
      runId: string;
      stepId?: string;
      signal?: AbortSignal;
    }): Promise<{ registered: string[]; skipped: string[]; warning?: string }>;
  };
  /** Cached/local catalog sources, including user-configured MCP servers. */
  localToolCandidates?: () => Promise<string[]>;
  /** Release resources such as browser sessions when an agent subtask ends. */
  releaseRunResources?: (input: { runId: string; stepId: string }) => Promise<void>;
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
    // Release the pause latch first, or a paused run would sit on it and never
    // observe the abort.
    clearPause(runId);
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
      clearPause(run.id);
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

  /**
   * Park here while the run is paused, writing 'paused' only if we actually
   * have to wait, and putting the run back to 'running' on the way out.
   */
  private async holdWhilePaused(runId: string, signal: AbortSignal): Promise<void> {
    let held = false;
    await waitWhilePaused(runId, signal, async () => {
      held = true;
      const run = await this.deps.store.getRun(runId);
      await this.patchRun(runId, {
        status: 'paused',
        pauses: [...(run?.pauses ?? []), { at: nowIso() }],
      });
    });
    if (held && !signal.aborted) {
      const run = await this.deps.store.getRun(runId);
      const pauses = [...(run?.pauses ?? [])];
      const openIndex = pauses.findLastIndex((pause) => pause.resumedAt === undefined);
      if (openIndex !== -1) pauses[openIndex] = { ...pauses[openIndex]!, resumedAt: nowIso() };
      await this.patchRun(runId, { status: 'running', pauses });
    }
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
        // The pause checkpoint. Before a step starts is the only place a pause
        // can take effect without leaving a half-done step behind.
        await this.holdWhilePaused(runId, signal);
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

        // Ungated actions return the action unchanged, so every caller can use
        // the return value uniformly instead of branching on whether a human
        // was involved.
        if (decision.riskClass !== 'ask_human') return action;

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
        const outcome = await waitForApproval(approval.id, action, signal);

        await this.patchRun(runId, { status: 'running' });
        await this.upsertStep(stepId, { status: 'running' });

        if (outcome.verdict === 'rejected') throw new ApprovalRejectedError(approval.id);

        if (outcome.verdict === 'revised') {
          await bus.emit(runId, {
            type: 'log',
            runId,
            level: 'info',
            message:
              'Approval ' +
              approval.id +
              ' was revised by a human and reauthorized; executing the revised ' +
              'payload, not the proposed one.',
            at: nowIso(),
          });
        }

        // The REVISED action when the human edited it. Callers execute this.
        return outcome.action;
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

      registeredToolIds: async (candidates: string[]): Promise<string[]> => {
        const registry = this.deps.toolRegistry;
        if (!registry) return candidates;
        const resolved = await registry.resolve(candidates);
        const executable = new Set(
          resolved
            .filter((descriptor) => descriptor.availability === 'available')
            .map((descriptor) => descriptor.id),
        );
        // Preserve the caller's ordering; it is the author's stated preference.
        return candidates.filter((id) => executable.has(id));
      },

      callBrokeredTool: async ({ stepId, toolId, args }) => {
        const broker = this.deps.toolBroker;
        const registry = this.deps.toolRegistry;
        if (!broker || !registry) return null;

        const [descriptor] = await registry.resolve([toolId]);
        // Unknown to the registry is not a broker problem -- let the caller
        // fall back to the provider catalog, which owns its own names.
        if (!descriptor) return null;

        // A short-lived session state whose ONLY purpose is to carry the
        // author's pinned choice as a grant the broker can verify. One tool,
        // one turn. It is not a harness session and never binds one.
        // HARNESS IS DELIBERATELY NOT 'hermes'.
        //
        // resolveActiveHarnessSession('hermes') requires exactly ONE active
        // hermes session and throws "multiple active sessions are ambiguous"
        // otherwise -- which is how Hermes's own MCP tool calls find their
        // context. Labelling this ephemeral grant-carrier as hermes made every
        // graph tool node leave a phantom hermes session behind, and the next
        // agent_task died with a 409 it had nothing to do with.
        //
        // This is not a harness session. It is a one-call grant, so it says so.
        const session = await sessionStateService.create({
          runId,
          stepId,
          harness: 'graph',
          objective: 'graph tool node: ' + toolId,
          dataLabels: ['private'],
          // One call, so one step of budget. This session exists to carry a
          // grant, not to run a loop.
          budget: { stepsRemaining: 1 },
          candidateToolIds: [toolId],
        });
        await sessionStateService.beginTurn(session.id);
        await sessionStateService.grantToolExposure(session.id, {
          modelCallId: 'graph-node:' + stepId,
          selectedToolVersions: { [descriptor.id]: descriptor.version },
        });

        try {
          const result = await broker.execute({
            sessionStateId: session.id,
            toolId: descriptor.id,
            arguments: args as Json,
            signal,
          });
          return { output: result.output, summary: result.summary };
        } finally {
          // The grant must not outlive the one call it was minted for, and
          // neither must the session: an ACTIVE one left behind is state that
          // later lookups have to disambiguate. Terminal status first, which
          // also clears the grant (see savePatch), then belt and braces.
          await sessionStateService.setStatus(session.id, 'completed').catch(() => undefined);
          await sessionStateService.clearToolExposure(session.id).catch(() => undefined);
        }
      },

      announceBrowserSession: async (session) => {
        await bus.emit(runId, {
          type: 'browser.session.opened',
          session: { runId, openedAt: nowIso(), ...session },
        });
      },

      releaseBrowserSession: async (sessionId) => {
        await bus.emit(runId, {
          type: 'browser.session.closed',
          runId,
          sessionId,
          at: nowIso(),
        });
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
        const executionProfile = spec.executionProfile ?? 'adaptive';
        const adaptiveProfile = executionProfile === 'adaptive';
        const step = await createStep({
          label: spec.label,
          kind: 'agent_task',
          nodeId: spec.nodeId,
          parentStepId: spec.parentStepId ?? null,
          // Read from the registry rather than hardcoded, so re-pointing
          // 'agent.runtime' in BINDINGS relabels the step too.
          providerId: providerFor('agent.runtime'),
        });

        // 1.5s x 80 = 120s total budget. A privacy transition can make one
        // Hermes turn include a cloud planning call, a live provider read, and
        // a local Ollama synthesis call. The previous 60s ceiling cancelled a
        // healthy local model seven seconds before it completed in a live Gmail
        // regression. Explicit graph budgets still override this default.
        const pollIntervalMs = spec.pollIntervalMs ?? 1500;
        // One turn can include cloud planning, a live provider read, and a
        // private local synthesis call. Keep the controller deadline longer
        // than Ollama's 180-second request timeout so it observes the real
        // provider outcome instead of pre-empting it.
        const maxPolls = spec.maxPolls ?? 160;
        const maxTurns = spec.maxTurns ?? 3;
        // Both undefined by default -- no wall-clock or failure ceiling beyond
        // maxPolls/maxTurns unless the graph author opts in.
        const maxDurationMs = spec.maxDurationMs;
        const maxFailedToolCalls = spec.maxFailedToolCalls;
        const startedAt = Date.now();
        let sessionStateId: string | undefined;

        try {
          // 1. Build the connected capability set. Composio supplies trusted
          //    metadata and execution, but it no longer semantically routes
          //    the prompt. Jev chooses a connected toolkit first, then chooses
          //    among that toolkit's normalized descriptors below.
          const labels: DataLabel[] = spec.dataLabels ?? ['public'];
          const sanitizedTask =
            spec.sanitizedGoal ??
            (labels.every((label) => label === 'public') ? spec.goal : undefined);
          const remoteForbidden = labels.some(
            (label) => label === 'secret' || label === 'local_only',
          );
          if (!adaptiveProfile && labels.some((label) => label !== 'public')) {
            throw new Error(
              'Hermes flagship baseline requires a public task because its fixed cloud model ' +
                'cannot receive private or local-only session state.',
            );
          }
          const decisionState: DecisionState = {
            taskSummary: sanitizedTask ?? 'Sensitive objective withheld.',
            dataLabels: labels,
            sanitizedForRemote: Boolean(sanitizedTask) && !remoteForbidden,
          };

          const emitControlDecision = async (
            operation: ControlDecisionOperation,
            candidateIds: string[],
            selectedIds: string[],
            confidence: number,
            reasonCodes: string[],
            candidateScores?: Record<string, number>,
            source?: 'jev' | 'deterministic' | 'fallback',
          ) => {
            await bus.emit(runId, {
              type: 'control.decided',
              decision: {
                id: newId('ctl'),
                runId,
                stepId: step.id,
                operation,
                candidateIds,
                candidateScores,
                selectedIds,
                confidence,
                reasonCodes,
                source: source ?? decisionSource(reasonCodes),
                at: nowIso(),
              },
            });
          };

          const discoveredIds: string[] = [];
          const managedToolIds: string[] = [];
          let taskToolIntent: ToolIntent = inferToolIntent(spec.goal);
          const nativeOnlyIntent =
            taskToolIntent.requiresTool &&
            taskToolIntent.requiredCapabilities.every((capability) =>
              ['weather.forecast', 'web.search', 'browser.navigate', 'browser.search'].includes(
                capability,
              ),
            );
          let selectedManagedToolkits: string[] = [];
          let suppressBrowserFallback = false;
          if (this.deps.localToolCandidates) {
            discoveredIds.push(...(await this.deps.localToolCandidates()));
          }
          if (this.deps.toolDiscovery && sanitizedTask && !remoteForbidden && !nativeOnlyIntent) {
            const connected = await this.deps.toolDiscovery.connectedToolkits({
              runId,
              stepId: step.id,
              signal,
            });
            if (connected.warning) {
              await ctx.log('warn', 'Connected tool catalog failed closed: ' + connected.warning);
            }
            const connectedIds = connected.toolkits.map((toolkit) => toolkit.slug);
            const explicitIds = explicitConnectedToolkitIds(spec.goal, connected.toolkits);
            const capabilityToolkitIds = shortlistConnectedToolkits(
              spec.goal,
              connected.toolkits,
            ).map((toolkit) => toolkit.slug);
            const familyCandidates =
              explicitIds.length > 0
                ? explicitIds
                : taskToolIntent.requiresTool
                  ? capabilityToolkitIds
                  : [];
            if (familyCandidates.length > 0) {
              const toolkitState: DecisionState = {
                ...decisionState,
                contextSummary: [
                  decisionState.contextSummary,
                  'Connected application toolkits: ' +
                    connected.toolkits
                      .map((toolkit) => toolkit.slug + ' (' + toolkit.name + ')')
                      .join(', ') +
                    '. Select only applications needed for the task.',
                ]
                  .filter((value): value is string => Boolean(value))
                  .join('\n'),
              };
              const deterministicToolkitIds = !adaptiveProfile
                ? familyCandidates
                : explicitIds.length > 0
                  ? explicitIds
                  : taskToolIntent.requiresTool
                    ? familyCandidates
                    : [];
              const toolkitDecision =
                deterministicToolkitIds.length === 0
                  ? await decisionService.selectToolFamilies(
                      toolkitState,
                      familyCandidates,
                      buildCallContext({
                        stepId: step.id,
                        policyRule: 'jev-connected-toolkit-selection',
                      }),
                    )
                  : {
                      selectedFamilies: deterministicToolkitIds,
                      confidences: Object.fromEntries(deterministicToolkitIds.map((id) => [id, 1])),
                      reasonCodes: [
                        !adaptiveProfile
                          ? 'hermes-flagship-deterministic-toolkit-retrieval'
                          : explicitIds.length > 0
                            ? 'explicit-connected-toolkit-constraint'
                            : 'deterministic-capability-toolkit-shortlist',
                      ],
                    };
              selectedManagedToolkits = toolkitDecision.selectedFamilies.filter((family) =>
                connectedIds.includes(family),
              );
              await emitControlDecision(
                'select_tool_families',
                familyCandidates,
                selectedManagedToolkits,
                average(Object.values(toolkitDecision.confidences)),
                toolkitDecision.reasonCodes,
                toolkitDecision.confidences,
                deterministicToolkitIds.length > 0 ? 'deterministic' : 'jev',
              );
              suppressBrowserFallback =
                adaptiveProfile &&
                selectedManagedToolkits.length > 0 &&
                !requestsBrowserAction(spec.goal);
            }

            if (selectedManagedToolkits.length > 0) {
              const imported = await this.deps.toolDiscovery.importToolkits({
                toolkits: selectedManagedToolkits,
                runId,
                stepId: step.id,
                signal,
              });
              discoveredIds.push(...imported.registered);
              managedToolIds.push(...imported.registered);
              if (imported.warning) {
                await ctx.log('warn', 'Connected tool import failed closed: ' + imported.warning);
              }
              if (imported.skipped.length > 0) {
                await ctx.log(
                  'info',
                  'Skipped ' + imported.skipped.length + ' unclassified provider tool(s).',
                );
              }
            }
          } else if (this.deps.toolDiscovery && (!sanitizedTask || remoteForbidden)) {
            await ctx.log(
              'info',
              'Skipped remote connected-tool metadata for sensitive task state.',
            );
          }

          // Resolve all candidates through the trusted registry, retrieve a
          // capability-compatible shortlist, then make one exact-tool Jev
          // decision before Hermes can start its inner loop.
          let availableTools = [...new Set([...spec.availableTools, ...discoveredIds])];
          if (suppressBrowserFallback) {
            availableTools = availableTools.filter((toolId) => !isBrowserToolId(toolId));
          }
          let selectedBeforeLegacyRoute = availableTools;
          if (taskToolIntent.requiresTool && !this.deps.toolRegistry) {
            const required = taskToolIntent.requiredCapabilities.join(', ');
            await ctx.log(
              'error',
              'Required tool capability cannot be verified because the trusted registry is ' +
                'unavailable. Required: ' +
                required,
            );
            throw new Error(
              'Trusted tool registry unavailable for required capability: ' + required,
            );
          }
          if (this.deps.toolRegistry) {
            const resolved = await this.deps.toolRegistry.resolve(availableTools);

            // SAY SO WHEN A CANDIDATE DOES NOT EXIST. `resolve` drops unknown
            // ids silently, and `eligibleTaskTools` drops unavailable ones, so
            // a graph naming tools that were renamed or never registered hands
            // the harness an EMPTY toolset and looks, from the outside, like
            // the harness simply failing at its job. That is exactly what
            // happened with `web.search`/`docs.read` in demo.graph: 0 of 7
            // resolved, Hermes fell back to its own tools, and the only symptom
            // was three `browser_exec` failures in a row.
            //
            // Warn, do not throw: an unknown candidate is an authoring mistake
            // to surface, not a reason to abort a run that may still succeed on
            // the tools that did resolve.
            const unknown = availableTools.filter(
              (id) => !resolved.some((descriptor) => descriptor.id === id),
            );
            if (unknown.length > 0) {
              await ctx.log(
                'warn',
                'Subtask "' +
                  spec.label +
                  '" named ' +
                  unknown.length +
                  ' tool(s) that are not in the registry, so they were dropped: ' +
                  unknown.join(', ') +
                  '. Use the ids from GET /api/tools.',
              );
            }

            const descriptors = eligibleTaskTools(resolved, decisionState);

            // Report WHY each tool was dropped, separately. Lumping these
            // together sends you hunting the wrong cause: the first time this
            // fired it blamed data labels when the real reason was that every
            // browser tool registers as `unavailable` outside live mode.
            const unavailable = resolved.filter(
              (descriptor) =>
                descriptor.availability !== 'available' ||
                descriptor.baselineEffect === 'unknown' ||
                descriptor.simulated === true,
            );
            const mislabelled = resolved.filter(
              (descriptor) =>
                !unavailable.includes(descriptor) &&
                !descriptors.some((kept) => kept.id === descriptor.id),
            );
            if (unavailable.length > 0) {
              await ctx.log(
                'warn',
                'Subtask "' +
                  spec.label +
                  '" dropped ' +
                  unavailable.length +
                  ' tool(s) as unavailable or unclassified: ' +
                  unavailable
                    .map((descriptor) => descriptor.id + ' (' + descriptor.availability + ')')
                    .join(', '),
              );
            }
            if (mislabelled.length > 0) {
              await ctx.log(
                'warn',
                'Subtask "' +
                  spec.label +
                  '" dropped ' +
                  mislabelled.length +
                  ' tool(s) whose data labels do not cover this task (' +
                  decisionState.dataLabels.join(', ') +
                  '): ' +
                  mislabelled.map((descriptor) => descriptor.id).join(', '),
              );
            }

            if (descriptors.length === 0 && availableTools.length > 0) {
              await ctx.log(
                'warn',
                'Subtask "' +
                  spec.label +
                  '" has NO usable tools after resolution. The harness will run as a ' +
                  'tool-less turn; any tool it appears to call is its own, not ours.',
              );
            }

            availableTools = descriptors.map((descriptor) => descriptor.id);
            const selection = adaptiveProfile
              ? await selectToolsForTask({
                  // Keep the original objective local. Sensitive state replaces
                  // DecisionState.taskSummary with a remote-safe placeholder, but
                  // deterministic capability detection still needs to know that
                  // "fetch email" requires an external email tool.
                  task: spec.goal,
                  state: decisionState,
                  candidates: descriptors,
                  decisions: decisionService,
                  context: buildCallContext({ stepId: step.id, policyRule: 'task-tool-selection' }),
                })
              : (() => {
                  const shortlist = buildToolShortlist(spec.goal, descriptors);
                  return {
                    ...shortlist,
                    reasonCodes: [
                      ...shortlist.reasonCodes,
                      'hermes-flagship-deterministic-tool-retrieval',
                    ],
                    selected: shortlist.candidates.map((candidate) => candidate.descriptor),
                    candidateScores: Object.fromEntries(
                      shortlist.candidates.map((candidate) => [
                        candidate.descriptor.id,
                        Math.max(0, Math.min(1, candidate.score / 200)),
                      ]),
                    ),
                    confidence: 1,
                    source: 'deterministic' as const,
                  };
                })();
            taskToolIntent = selection.intent;
            selectedBeforeLegacyRoute = selection.selected.map((descriptor) => descriptor.id);
            await emitControlDecision(
              'select_tools',
              selection.candidates.map((candidate) => candidate.descriptor.id),
              selectedBeforeLegacyRoute,
              selection.confidence,
              selection.reasonCodes,
              selection.candidateScores,
              selection.source,
            );
            if (selection.intent.requiresTool && selectedBeforeLegacyRoute.length === 0) {
              const required = selection.intent.requiredCapabilities.join(', ');
              await ctx.log(
                'error',
                'Required tool capability is unavailable; refusing to start a tool-less ' +
                  'Hermes turn. Required: ' +
                  required,
              );
              throw new Error('Required tool capability unavailable: ' + required);
            }
          }

          const directWeatherArguments =
            adaptiveProfile &&
            selectedBeforeLegacyRoute.length === 1 &&
            selectedBeforeLegacyRoute[0] === 'weather.forecast'
              ? weatherArgumentsForTask(spec.goal)
              : null;
          const candidateWebSearchArguments =
            adaptiveProfile &&
            selectedBeforeLegacyRoute.length === 1 &&
            selectedBeforeLegacyRoute[0] === 'web.search'
              ? webSearchArgumentsForTask(spec.goal)
              : null;

          // The legacy route call now provides only coarse privacy/tier fields.
          // Typed Jev decisions above own tool selection; asking the legacy
          // router to filter the same IDs again caused useful tools to vanish.
          const decider = provider('decision');
          const routed =
            adaptiveProfile &&
            !directWeatherArguments &&
            (decider.mode !== 'live' || decisionState.sanitizedForRemote)
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
          const routeResult = directWeatherArguments
            ? {
                privacy: 'cloud' as const,
                intelligence: 'low' as const,
                privacyConfidence: 1,
                intelligenceConfidence: 1,
                modelTier: 'cheap' as const,
                exposedTools: selectedBeforeLegacyRoute,
                confidence: 1,
                rationale: 'Direct verified structured weather read; no harness model required.',
              }
            : !adaptiveProfile
              ? {
                  privacy: 'cloud' as const,
                  intelligence: 'high' as const,
                  privacyConfidence: 1,
                  intelligenceConfidence: 1,
                  modelTier: 'frontier' as const,
                  exposedTools: selectedBeforeLegacyRoute,
                  confidence: 1,
                  rationale: 'Hermes fixed-frontier comparison profile.',
                }
              : routed?.ok
                ? {
                    ...routed.data,
                    exposedTools: selectedBeforeLegacyRoute,
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

          // Jev's model-tier decision is also the delegation decision. Cheap
          // public lookups can return the cited search answer directly. More
          // complex searches stay in Hermes so the selected stronger model can
          // iterate over sources and synthesize them.
          const directWebSearchArguments =
            candidateWebSearchArguments && routeResult.modelTier === 'cheap'
              ? candidateWebSearchArguments
              : null;
          const directReadPlan = directWeatherArguments
            ? {
                toolId: 'weather.forecast' as const,
                capability: 'weather.forecast' as const,
                arguments: directWeatherArguments,
                stepLabel: 'Fetch exact-hour weather forecast',
                artifactKind: 'weather_forecast',
                verificationCode: 'verified-structured-weather-result',
              }
            : directWebSearchArguments
              ? {
                  toolId: 'web.search' as const,
                  capability: 'web.search' as const,
                  arguments: directWebSearchArguments,
                  stepLabel: 'Search the live public internet',
                  artifactKind: 'grounded_web_search',
                  verificationCode: 'verified-cited-web-search-result',
                }
              : null;

          if (taskToolIntent.requiresTool && routeResult.exposedTools.length === 0) {
            const required = taskToolIntent.requiredCapabilities.join(', ');
            await ctx.log(
              'error',
              'Required tool capability was not exposed by routing; refusing to start Hermes. ' +
                'Required: ' +
                required,
            );
            throw new Error('Required tool capability not exposed: ' + required);
          }

          const decision: ScheduleDecision = {
            id: newId('sch'),
            runId,
            stepId: step.id,
            requestedCapability: directReadPlan?.capability ?? 'agent.runtime',
            selectedProvider: directReadPlan
              ? providerFor(directReadPlan.capability)
              : providerFor('agent.runtime'),
            privacy: routeResult.privacy,
            intelligence: routeResult.intelligence,
            privacyConfidence: routeResult.privacyConfidence,
            intelligenceConfidence: routeResult.intelligenceConfidence,
            modelTier: routeResult.modelTier,
            availableTools,
            exposedTools: routeResult.exposedTools,
            confidence: routeResult.confidence,
            escalated: false,
            rule: directReadPlan
              ? 'jev-direct-verified-read'
              : !adaptiveProfile
                ? 'hermes-flagship-baseline'
                : routed?.ok
                  ? 'jev-routed'
                  : 'route-failed-safe-local',
            at: nowIso(),
          };
          await store.createScheduleDecision(decision);
          await bus.emit(runId, { type: 'schedule.decided', decision });

          const exposedDescriptors = this.deps.toolRegistry
            ? await this.deps.toolRegistry.resolve(decision.exposedTools)
            : [];
          const requiredActionToolIds = new Set(
            requiredToolIdsForGoal(
              spec.goal,
              exposedDescriptors,
              managedToolIds,
              selectedManagedToolkits.length > 0,
            ),
          );

          // 2. Register AgentOS's canonical state BEFORE Hermes can make its
          // first model request. The model gateway resolves this active record
          // and never treats Hermes's internal transcript as canonical state.
          const sessionState = await sessionStateService.create({
            runId,
            stepId: step.id,
            harness: directReadPlan ? 'agentos-direct' : 'hermes',
            executionProfile,
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

          if (directReadPlan) {
            const descriptor = exposedDescriptors.find(
              (candidate) => candidate.id === directReadPlan.toolId,
            );
            if (!descriptor || !this.deps.toolBroker) {
              throw new Error('Direct read route is missing its trusted tool binding.');
            }
            await sessionStateService.grantToolExposure(sessionState.id, {
              modelCallId: 'jev-direct-route:' + step.id,
              selectedToolVersions: { [descriptor.id]: descriptor.version },
            });
            await this.upsertStep(step.id, { providerId: decision.selectedProvider });
            const toolResult = await this.deps.toolBroker.execute({
              sessionStateId: sessionState.id,
              toolId: descriptor.id,
              arguments: directReadPlan.arguments,
              signal,
            });
            if (toolResult.verified !== true) {
              throw new Error('Direct read result was not verified by its executor.');
            }
            const checkpoint: SessionCheckpoint = {
              runId,
              objective: spec.goal,
              sanitizedObjective: sanitizedTask,
              steps: [
                {
                  id: step.id + ':direct-read',
                  label: directReadPlan.stepLabel,
                  status: 'succeeded',
                  required: true,
                  sanitizedSummary: toolResult.summary,
                },
              ],
              artifacts: [
                {
                  id: step.id + ':direct-read-result',
                  kind: directReadPlan.artifactKind,
                  required: true,
                  verified: true,
                  dataLabels: labels,
                  sanitizedSummary: toolResult.summary,
                },
              ],
              verifications: [
                {
                  id: step.id + ':direct-read-result-verified',
                  passed: true,
                  required: true,
                  reasonCode: directReadPlan.verificationCode,
                },
              ],
              outstandingRequirements: [],
              pendingApprovalIds: [],
              dataLabels: labels,
              budget: { stepsRemaining: Math.max(0, maxTurns - 1) },
              at: nowIso(),
            };
            await sessionStateService.checkpoint(sessionState.id, checkpoint);
            const completionDecision = await judgeCheckpoint(checkpoint, step.id);
            if (completionDecision.status !== 'done' || !completionDecision.verified) {
              throw new Error('Jev did not verify the completed direct read result.');
            }
            await sessionStateService.setStatus(sessionState.id, 'completed');
            const toolCalls = [
              {
                tool: descriptor.id,
                args: directReadPlan.arguments,
                at: nowIso(),
              },
            ];
            await ctx.log(
              'info',
              'Completed a Jev-selected verified read directly; Hermes was not started.',
            );
            await this.upsertStep(step.id, {
              status: 'succeeded',
              output: toJson({
                result: toolResult.summary,
                toolCallCount: 1,
                toolCalls,
                completionDecision,
              }),
              endedAt: nowIso(),
            });
            return {
              result: toolResult.summary,
              scheduleDecision: decision,
              toolCalls,
              completionDecision,
            };
          }

          // 3. Start Hermes with the profile's tool set. Adaptive runs use the
          // Jev shortlist; the flagship baseline uses every policy-eligible tool.
          const runtime = provider('agent.runtime');
          const harnessPolicyRule = adaptiveProfile
            ? 'jev-filtered-toolset'
            : 'hermes-flagship-baseline';
          const started = await runtime.startTask(
            { goal: spec.goal, context: spec.context, tools: decision.exposedTools },
            buildCallContext({ stepId: step.id, policyRule: harnessPolicyRule }),
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
          let usedVerifiedReadShortcut = false;
          const requiresToolAction = taskToolIntent.requiresTool;

          for (let turn = 1; turn <= maxTurns; turn += 1) {
            // Second pause checkpoint. An agent task is one `ctx.step`, so
            // without this a paused run would still burn its whole turn budget
            // before noticing.
            await this.holdWhilePaused(runId, signal);

            let turnCompleted = false;
            let turnToolCalls: { tool: string; args?: unknown; at: string }[] = [];
            let pollAttempts = 0;
            while (pollAttempts < maxPolls) {
              if (signal.aborted) throw new Error('Run aborted while awaiting agent task');

              if (maxDurationMs !== undefined && Date.now() - startedAt >= maxDurationMs) {
                await ctx.log(
                  'warn',
                  'Agent task ' + taskId + ' hit its maxDurationMs budget; stopping.',
                );
                break;
              }
              if (maxFailedToolCalls !== undefined) {
                const failedCount = (await store.eventsSince(runId, 0)).filter(
                  ({ event }) =>
                    event.type === 'tool.lifecycle' &&
                    event.lifecycle.stepId === step.id &&
                    event.lifecycle.phase === 'failed',
                ).length;
                if (failedCount > maxFailedToolCalls) {
                  await ctx.log(
                    'warn',
                    'Agent task ' + taskId + ' exceeded its maxFailedToolCalls budget; stopping.',
                  );
                  break;
                }
              }

              const polled = await runtime.pollTask(
                taskId,
                buildCallContext({ stepId: step.id, policyRule: harnessPolicyRule }),
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

              const readShortcut = verifiedReadShortcut(
                await store.eventsSince(runId, 0),
                step.id,
                requiredActionToolIds,
                exposedDescriptors,
              );
              if (readShortcut) {
                finalResult = readShortcut.result;
                turnToolCalls = readShortcut.toolCalls;
                toolCalls.push(...turnToolCalls);
                turnCompleted = true;
                usedVerifiedReadShortcut = true;
                await ctx.log(
                  'info',
                  'Used the verified structured weather result directly; skipped a redundant harness synthesis turn.',
                );
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

            // A rejected exact action is a terminal human decision for this
            // objective. Hermes still receives the tool error so its current
            // inner turn can quiesce, but the outer loop must not spend more
            // model turns trying to work around the user's refusal.
            const rejectedApproval = (await store.listApprovals(runId)).find(
              (approval) => approval.stepId === step.id && approval.status === 'rejected',
            );
            if (rejectedApproval) {
              await sessionStateService.setStatus(sessionState.id, 'cancelled');
              await runtime.cancelTask(
                taskId,
                buildCallContext({
                  stepId: step.id,
                  policyRule: 'human-rejected-tool-action',
                }),
              );
              throw new ApprovalRejectedError(rejectedApproval.id);
            }

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
            const stepEvents = await store.eventsSince(runId, 0);
            const modelEvidence = modelCompletionEvidence(stepEvents, step.id);
            const requiresModelEvidence = runtime.mode === 'live';
            const hasSuccessfulModelResult =
              usedVerifiedReadShortcut || !requiresModelEvidence || modelEvidence.verified;
            if (!hasSuccessfulModelResult) {
              throw new Error(
                modelEvidence.failureMessage
                  ? 'Agent model call failed: ' + modelEvidence.failureMessage
                  : 'Agent task ended without a completed AgentOS model call.',
              );
            }
            // Harness tool-result messages include provider errors as well as
            // successes. Only the broker's authoritative lifecycle event proves
            // that the exact action passed policy, approval, execution, and
            // verification; never infer success from a role=tool transcript entry.
            const hasSuccessfulToolResult = stepEvents.some(
              ({ event }) =>
                event.type === 'tool.lifecycle' &&
                event.lifecycle.stepId === step.id &&
                event.lifecycle.phase === 'succeeded' &&
                requiredActionToolIds.has(event.lifecycle.action.toolId),
            );
            const resultSummary = hasResult ? summarizeHarnessResult(finalResult) : undefined;
            const sanitizedResultSummary =
              resultSummary && labels.every((label) => label === 'public')
                ? (await ctx.redact(resultSummary, 'agent_result')).redacted
                : undefined;
            const verifiedOutcome =
              hasResult &&
              hasSuccessfulModelResult &&
              (!requiresToolAction || hasSuccessfulToolResult);
            const outstandingRequirements = [
              ...(!hasResult ? ['agent-result-missing'] : []),
              ...(!hasSuccessfulModelResult ? ['model-call-not-completed'] : []),
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
                    ? sanitizedResultSummary
                      ? 'Hermes result: ' + sanitizedResultSummary
                      : 'Hermes produced a result for the requested objective.'
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
                    ? sanitizedResultSummary
                      ? 'Verified harness result: ' + sanitizedResultSummary
                      : 'The required harness result and tool action are present and verified.'
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
                {
                  id: step.id + ':model-call-completed',
                  passed: hasSuccessfulModelResult,
                  required: true,
                  reasonCode: requiresModelEvidence
                    ? modelEvidence.verified
                      ? 'model-call-completed'
                      : 'model-call-not-completed'
                    : 'model-call-simulated-by-mock-runtime',
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
            if (adaptiveProfile) {
              completionDecision = await judgeCheckpoint(checkpoint, step.id);
            } else {
              const status = verifiedOutcome
                ? ('done' as const)
                : checkpoint.budget.stepsRemaining > 0
                  ? ('continue' as const)
                  : ('blocked' as const);
              completionDecision = {
                status,
                confidence: 1,
                probabilities: { [status]: 1 },
                reasonCodes: ['hermes-flagship-deterministic-completion'],
                verified: status === 'done',
                verificationFailures: outstandingRequirements,
              };
              await emitControlDecision(
                'judge_completion',
                ['done', 'continue', 'blocked'],
                [status],
                1,
                completionDecision.reasonCodes,
                undefined,
                'deterministic',
              );
            }

            if (completionDecision.status === 'done' && completionDecision.verified) {
              completed = true;
              await sessionStateService.setStatus(sessionState.id, 'completed');
              break;
            }
            if (completionDecision.status === 'blocked') {
              // The spec is explicit: `blocked` PAUSES for the user. Failing
              // the run here instead would throw away a Hermes session that is
              // still alive and still resumable, and would report a run that is
              // merely stuck as a run that broke.
              await sessionStateService.setStatus(sessionState.id, 'blocked');
              const reason =
                completionDecision.verificationFailures.join(', ') ||
                completionDecision.reasonCodes.join(', ') ||
                'no reason given';
              await bus.emit(runId, {
                type: 'log',
                runId,
                level: 'warn',
                message:
                  'The completion judge returned `blocked` (' +
                  reason +
                  '). Pausing for you — resume the run to continue, or cancel it.',
                at: nowIso(),
              });

              pauseRun(runId);
              await this.holdWhilePaused(runId, signal);
              if (signal.aborted) throw new Error('Run cancelled while blocked: ' + reason);

              // Resumed by a human. Fall through to the continuation below and
              // spend another bounded turn in the SAME Hermes session.
              await sessionStateService.setStatus(sessionState.id, 'running');
            }
            if (turn < maxTurns) {
              await sessionStateService.beginTurn(sessionState.id);
              const continued = await runtime.continueTask(
                taskId,
                {
                  instruction:
                    'Continue working toward this exact original objective: ' +
                    JSON.stringify(spec.goal) +
                    (hasSuccessfulToolResult
                      ? '. The required external tool already succeeded. Do not call it again; use the existing tool result in this session to produce the missing final answer. For a read request, present the retrieved records directly with their count and useful fields instead of merely reporting that the fetch succeeded or asking a follow-up question. Resolve every missing verification before stopping.'
                      : '. You must use an available tool when the objective requests an external action; do not claim completion until the tool succeeds. Resolve every missing verification before stopping.'),
                  context: {
                    previousResultPresent: hasResult,
                    successfulToolResultPresent: hasSuccessfulToolResult,
                  },
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
        } finally {
          try {
            await this.deps.releaseRunResources?.({ runId, stepId: step.id });
          } catch (error) {
            await ctx.log(
              'warn',
              'Run resource cleanup failed: ' +
                (error instanceof Error ? error.message : String(error)),
            );
          }
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

export function requiresExternalAction(goal: string): boolean {
  const normalized = goal.trim();
  if (requiresMutationAction(normalized)) {
    return true;
  }

  if (requestsBrowserAction(normalized)) {
    return true;
  }

  // "Reply exactly ..." and "reply with ..." are ordinary text-generation
  // requests. Only a reply directed to an external channel/recipient requires
  // authoritative tool-success evidence before completion can be verified.
  return /^(?:please\s+)?reply\s+(?:to|via|by)\b/i.test(normalized);
}

export function requiresMutationAction(goal: string): boolean {
  return /^(?:please\s+)?(?:send|email|message|forward|post|publish|submit|create|update|delete|remove|invite|schedule|book|purchase|pay|transfer)\b/i.test(
    goal.trim(),
  );
}

export function requestsBrowserAction(goal: string): boolean {
  const normalized = goal.trim();
  return (
    /\b(?:browser|browse|web(?:site)?|https?:\/\/)/i.test(normalized) &&
    /\b(?:use|open|visit|navigate|search|inspect|extract|click|type|submit)\b/i.test(normalized)
  );
}

/** Honor an explicit app constraint before any model-selected fallback. */
export function explicitConnectedToolkitIds(
  goal: string,
  toolkits: ToolboxToolkitDefinition[],
): string[] {
  const normalized = goal
    .toLowerCase()
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return toolkits.flatMap((toolkit) => {
    const slug = toolkit.slug.toLowerCase();
    const name = toolkit.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const namedProduct = ['gmail', 'github', 'slack', 'notion', 'google calendar'].some(
      (product) => name === product && containsPhrase(normalized, product),
    );
    const contextualAliases: Record<string, string[]> = {
      googlecalendar: ['calendar', 'google calendar'],
      googlesheets: ['sheets', 'google sheets'],
      googledrive: ['drive', 'google drive'],
    };
    const contextMatched = (contextualAliases[slug] ?? []).some(
      (alias) =>
        containsPhrase(normalized, 'using ' + alias) ||
        containsPhrase(normalized, 'via ' + alias) ||
        containsPhrase(normalized, 'through ' + alias) ||
        (alias.startsWith('google ') && containsPhrase(normalized, alias)),
    );
    return namedProduct || contextMatched ? [toolkit.slug] : [];
  });
}

export function requiredToolIdsForGoal(
  goal: string,
  exposedDescriptors: ToolDescriptor[],
  managedToolIds: string[],
  managedToolkitSelected: boolean,
): string[] {
  const managed = new Set(managedToolIds);
  const expected = managedToolkitSelected
    ? exposedDescriptors.filter((descriptor) => managed.has(descriptor.id))
    : exposedDescriptors;
  const effectEligible = requiresMutationAction(goal)
    ? expected.filter((descriptor) => descriptor.baselineEffect !== 'read')
    : expected;
  return effectEligible.map((descriptor) => descriptor.id);
}

function containsPhrase(value: string, phrase: string): boolean {
  return (' ' + value + ' ').includes(' ' + phrase + ' ');
}

function isBrowserToolId(toolId: string): boolean {
  return toolId.startsWith('localbrowser.') || toolId.startsWith('browserbase.');
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

/**
 * Redacted model-visible result evidence for Jev's completion judgment.
 * Retrieval answers routinely exceed 1,000 characters; truncating them there
 * hid the record count and conclusion, so Jev repeatedly saw an apparently
 * partial answer. The completion state itself remains capped at 8,000 chars.
 */
function summarizeHarnessResult(value: unknown): string | undefined {
  const candidate =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'text' in value && typeof value.text === 'string'
        ? value.text
        : JSON.stringify(toJson(value));
  const normalized = candidate?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length <= 6_000 ? normalized : normalized.slice(0, 5_997) + '...';
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
