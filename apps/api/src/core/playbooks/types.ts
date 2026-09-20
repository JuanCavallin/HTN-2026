/**
 * The playbook contract — THE PIVOT SEAM.
 *
 * When the product idea is decided, everything product-specific lives in one file
 * implementing `Playbook`, plus its zod input schema in
 * packages/shared/src/schemas/playbooks/. Nothing above this layer changes.
 *
 * A playbook never touches the store, the bus, express, or a vendor SDK. It is
 * handed a `PlaybookContext` and uses only that.
 */

import type { ZodType } from 'zod';
import type {
  Capability,
  CapabilityMap,
  IntelligenceLevel,
  Json,
  ModelTier,
  PrivacyRoute,
  ProposedAction,
  ProviderCallContext,
  ProviderId,
  ScheduleDecision,
  Step,
} from '@htn/shared';
import type { FanOutOutcome } from '../swarm.js';

export interface StepSpec {
  label: string;
  /** 'fetch' | 'worker' | 'judge' | 'browse' | 'decide' | ... Free-form; drives icons. */
  kind?: string;
  /**
   * The graph node this step belongs to, when the run came from a graph. Set by
   * the interpreter; a hand-written playbook leaves it undefined. See Step.nodeId.
   */
  nodeId?: string;
  parentStepId?: string | null;
  providerId?: ProviderId;
  input?: Json;
}

export interface FanOutSpec<I, O> {
  /** Label for the parent step that contains the swarm. */
  label: string;
  /** Applied to the parent AND every child, so a fan-out reports as one node. */
  nodeId?: string;
  items: I[];
  concurrency?: number;
  /** Label for each child step. Shown in the SwarmGrid. */
  workerLabel: (item: I, index: number) => string;
  worker: (item: I, index: number, step: Step) => Promise<O>;
}

export interface RedactionOutput {
  /** Safe to send to a cloud provider. */
  redacted: string;
  /** Pass into the ProviderCallContext so the ledger records what class of data left. */
  redactions: { placeholder: string; type: string }[];
  /** True when at least one sensitive span was found and pinned locally. */
  hadSensitive: boolean;
}

export interface AgentTaskSpec {
  /** Step label shown in the timeline. */
  label: string;
  /** The goal handed to the agent runtime. */
  goal: string;
  /** Extra context passed through untouched — redact it first if it might be sensitive. */
  context?: unknown;
  /**
   * Full candidate tool list BEFORE Jev filters it. Not tied to any one
   * provider's tool-name format — the harness-specific `live.ts` is
   * responsible for translating these into whatever that runtime expects.
   * Do NOT include tools classified irreversible; see hermes/live.ts's safety
   * rule for why.
   */
  availableTools: string[];
  /** The graph node this task belongs to. See Step.nodeId. */
  nodeId?: string;
  parentStepId?: string | null;
  /** How often to poll while the task runs. Default 1500ms — see orchestrator.ts. */
  pollIntervalMs?: number;
  /**
   * ABSOLUTE safety ceiling: give up after this many polls no matter what,
   * so a genuinely hung task cannot hold a run open forever. Default 400
   * (~10 minutes at the default interval).
   *
   * In practice `inactivityTimeoutMs` below is what actually ends a stuck
   * task — it fires much sooner, because a real hang produces no new
   * activity long before ten minutes of wall clock pass. This ceiling is the
   * backstop for a runtime that keeps reporting fresh activity indefinitely.
   */
  maxPolls?: number;
  /**
   * Give up if the runtime reports NO activity (no chunk, no tool call —
   * see `lastActivityAt`) for this long, even though polling itself hasn't
   * hit `maxPolls` yet. Default 120_000 (2 minutes).
   *
   * This is the fix for "a real task that's just slow gets killed at the same
   * moment as one that's truly stuck" — a harness that keeps reporting
   * progress is left alone regardless of total elapsed time, while one that
   * goes silent is caught well before the absolute ceiling. Only enforced
   * when the runtime actually reports `lastActivityAt`; a runtime that
   * cannot (see AgentRuntimeAdapter.pollTask) falls back to `maxPolls` alone.
   */
  inactivityTimeoutMs?: number;
}

export interface AgentTaskResult {
  result: unknown;
  /** The routing decision Jev made before this task started. */
  scheduleDecision: ScheduleDecision;
  /** Self-reported by the runtime; our only post-hoc visibility into its internal loop. */
  toolCalls: { tool: string; args?: unknown; at: string }[];
}

export interface PlaybookContext {
  readonly runId: string;
  readonly signal: AbortSignal;

  /** Append a log line to the run. */
  log(level: 'info' | 'warn' | 'error', message: string): Promise<void>;

  /**
   * Run one step. Handles the status transitions and events; you write the body.
   * Throwing inside `fn` marks the step failed and propagates.
   */
  step<T>(spec: StepSpec, fn: (step: Step) => Promise<T>): Promise<T>;

  /**
   * Fan out N workers as child steps of one parent step. This is the entire cost
   * of a swarm — the UI renders it from parentStepId with no extra work.
   */
  fanOut<I, O>(spec: FanOutSpec<I, O>): Promise<FanOutOutcome<O>[]>;

  /**
   * Classify an action and, if the policy demands a human, BLOCK until they decide.
   * Throws ApprovalRejectedError when rejected.
   */
  requireApproval(stepId: string, action: ProposedAction): Promise<void>;

  /** Get a provider by capability — never by vendor name. */
  provider<C extends Capability>(capability: C): CapabilityMap[C];

  /**
   * Which vendor is currently bound to a capability.
   *
   * For LABELLING ONLY — a step badge, a log line. Never branch on this: the
   * whole point of the capability indirection is that behaviour does not depend
   * on who is serving it. It exists because a hardcoded `providerId: 'jev'` on
   * a step becomes a lie the moment someone repoints BINDINGS, and a dashboard
   * that misreports which vendor ran is worse than one that says nothing.
   */
  providerFor(capability: Capability): ProviderId;

  /** Detect PII, pin it locally, and return cloud-safe text. */
  redact(text: string, field: string): Promise<RedactionOutput>;

  /**
   * Run one subtask on the harness bound to 'agent.runtime' (Hermes today,
   * but never mentioned by name here — that's what makes this harness
   * agnostic). Jev decides the model tier and filters `availableTools` down
   * BEFORE the task starts; this is where tool/model optimization actually
   * happens, at subtask granularity rather than per literal model turn,
   * because the runtime's own internal loop is opaque to us once running.
   * Blocks until the task reports done, fails, or maxPolls is exceeded.
   */
  runAgentTask(spec: AgentTaskSpec): Promise<AgentTaskResult>;

  /**
   * Record a routing decision made OUTSIDE runAgentTask.
   *
   * runAgentTask records its own, but the `dispatch` node -- where the decision
   * layer picks ONE tool and the interpreter calls it directly, with no agent
   * harness in the middle -- needs the same visibility. Without this, the cheap
   * path would look like it did no routing at all and the
   * availableTools-vs-exposedTools number would only ever come from the
   * expensive path.
   */
  recordSchedule(input: {
    stepId: string;
    requestedCapability: Capability;
    selectedProvider: ProviderId;
    privacy?: PrivacyRoute;
    intelligence?: IntelligenceLevel;
    privacyConfidence?: number;
    intelligenceConfidence?: number;
    modelTier: ModelTier;
    availableTools: string[];
    exposedTools: string[];
    confidence: number;
    rule: string;
  }): Promise<ScheduleDecision>;

  /** Build the context every provider call requires. */
  callContext(args: {
    stepId?: string;
    policyRule: string;
    redactions?: { placeholder: string; type: string }[];
  }): ProviderCallContext;
}

export interface PlaybookOutcome {
  /** One line shown on the run card. */
  summary: string;
  /** Per-kind payload. The UI picks a renderer by run.kind. */
  result?: Json;
}

export interface Playbook<I = unknown> {
  kind: string;
  title: string;
  inputSchema: ZodType<I>;
  /**
   * Can the generic "pick a playbook and go" form launch this with NO input?
   *
   * Defaults to true. `graph` sets it false: it needs a graphId, so offering it
   * in a dropdown that posts `{}` produces a guaranteed validation error. If
   * you add a playbook with required input, set this, or the launch form will
   * advertise a button that cannot work.
   */
  directLaunch?: boolean;
  execute(ctx: PlaybookContext, input: I): Promise<PlaybookOutcome>;
}

/** Helper so a playbook file can be written without repeating the generic. */
export function definePlaybook<I>(playbook: Playbook<I>): Playbook<I> {
  return playbook;
}
