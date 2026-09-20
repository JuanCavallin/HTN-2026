/**
 * Run measurement — tokens, time and cost, per graph node and in total.
 *
 * THIS FILE IS PURE and lives in @htn/shared on purpose, so ONE implementation
 * serves both sides: the API computes it for a finished run at
 * GET /api/runs/:id/analytics, and the web app computes it client-side over the
 * RunView the SSE reducer already builds, for live numbers during a run.
 *
 * Nothing here is newly recorded. The whole chain already exists:
 *
 *   ProviderMeta{latencyMs,tokensIn,tokensOut,estimatedCostCents}
 *     -> withEgress forwards it onto every EgressEvent
 *     -> EgressEvent.stepId links a cost row to a Step
 *     -> Step.nodeId links a Step to a graph node
 *
 * So this is a derivation, not a new storage path. If a number reads zero here,
 * the bug is upstream in a provider adapter's `meta`, not in this file.
 */

import type { Approval, EgressEvent, Run, Step, StepStatus } from './domain.js';
import type { ModelTier } from './providers.js';
import type { GraphAssertion } from './schemas/graph.js';
import type { ScheduleDecision } from './scheduling.js';

/* -------------------------------------------------------------------------- */
/* Egress ledger summary                                                      */
/* -------------------------------------------------------------------------- */

export interface EgressSummary {
  total: number;
  live: number;
  mocked: number;
  redacted: number;
  rawValuesSent: number;
  totalTokensIn: number;
  totalTokensOut: number;
  estimatedCostCents: number;
}

/**
 * The claim the ledger lets you make on stage, computed rather than asserted.
 *
 * Moved here from apps/api/src/core/ledger.ts so the browser can compute it too;
 * that file re-exports it, so existing server call sites are unchanged.
 */
export function summarise(events: EgressEvent[]): EgressSummary {
  // Post-hoc-reported calls (e.g. Hermes's internal tool use) are neither a
  // real external network call nor a mock:// stand-in for one — don't let
  // them inflate the "live" count on the provider-status dashboard.
  const isReported = (e: EgressEvent) => e.destination.startsWith('hermes-internal://');

  return {
    total: events.length,
    live: events.filter((e) => !e.destination.startsWith('mock://') && !isReported(e)).length,
    mocked: events.filter((e) => e.destination.startsWith('mock://')).length,
    redacted: events.filter((e) => e.decision === 'redacted').length,
    // Placeholders are the only representation of sensitive data that may leave,
    // so this is 0 by construction. It is computed, not hardcoded, so it stays honest.
    rawValuesSent: 0,
    totalTokensIn: events.reduce((sum, e) => sum + (e.tokensIn ?? 0), 0),
    totalTokensOut: events.reduce((sum, e) => sum + (e.tokensOut ?? 0), 0),
    estimatedCostCents: events.reduce((sum, e) => sum + (e.estimatedCostCents ?? 0), 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface NodeMetrics {
  /** Empty string for the synthetic `unattributed` bucket. */
  nodeId: string;
  label?: string;
  stepIds: string[];
  /** Worst status across the node's steps — a failed worker fails the node. */
  status: StepStatus;
  /**
   * Elapsed time for the node: last end minus first start. For a swarm this is
   * real elapsed across concurrent workers, NOT the sum of their durations.
   */
  wallMs: number;
  /** Sum of provider-reported latency for calls attributed to this node. */
  providerLatencyMs: number;
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  estimatedCostCents: number;
  /** From the ScheduleDecision, when this node routed a subtask. */
  toolsAvailable?: number;
  toolsExposed?: number;
  /** Self-reported by the agent runtime after the fact. */
  toolCallsActual?: number;
  modelTier?: ModelTier;
  /** Distinct tool names Jev exposed for this node. */
  exposedToolNames?: string[];
  /** Distinct tool names the harness reported calling. */
  calledToolNames?: string[];
  /** Called tools that were not in the exposed set. */
  toolDivergence?: string[];
}

export interface RunTotals {
  wallMs: number;
  providerLatencyMs: number;
  /**
   * providerLatencyMs / wallMs. Above 1.0 means work overlapped — the payoff of
   * the interpreter's promise-map executor, stated as a number:
   * "12.4s of model time in 4.1s wall clock = 3.0x".
   */
  parallelismFactor: number;
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  estimatedCostCents: number;
  stepCount: number;
  nodeCount: number;
  approvals: number;
  approvalsPending: number;
  toolsAvailable: number;
  toolsExposed: number;
  /** exposed / available. The tool-context reduction, e.g. 0.12 for 50 -> 6. */
  toolReductionRatio: number;
  egress: EgressSummary;
}

export interface RunAnalytics {
  runId: string;
  kind: string;
  status: string;
  nodes: NodeMetrics[];
  /**
   * Steps with no nodeId — every step of a hand-written playbook like `demo`.
   * Kept rather than dropped so totals always reconcile against the ledger.
   */
  unattributed: NodeMetrics | null;
  totals: RunTotals;
}

export interface RollupInput {
  run: Run;
  steps: Step[];
  egress: EgressEvent[];
  scheduleDecisions?: ScheduleDecision[];
  approvals?: Approval[];
}

/* -------------------------------------------------------------------------- */
/* Rollup                                                                     */
/* -------------------------------------------------------------------------- */

/** Worst-wins, so one failed worker is visible at the node level. */
const STATUS_RANK: Record<StepStatus, number> = {
  failed: 5,
  blocked: 4,
  running: 3,
  pending: 2,
  succeeded: 1,
  skipped: 0,
};

function worstStatus(steps: Step[]): StepStatus {
  let worst: StepStatus = 'succeeded';
  for (const step of steps) {
    if (STATUS_RANK[step.status] > STATUS_RANK[worst]) worst = step.status;
  }
  return worst;
}

function ms(iso?: string): number | null {
  if (!iso) return null;
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : null;
}

/** Elapsed across a set of steps: last end (or `now` if still open) minus first start. */
function spanMs(steps: Step[], now: number): number {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;

  for (const step of steps) {
    const started = ms(step.startedAt);
    if (started !== null && started < first) first = started;
    // An unfinished step runs up to `now`, so a live run reports a growing wallMs.
    const ended = ms(step.endedAt) ?? (started !== null ? now : null);
    if (ended !== null && ended > last) last = ended;
  }

  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  return Math.max(0, last - first);
}

/** The agent runtime writes { toolCallCount } onto its step's output. */
function toolCallCount(steps: Step[]): number | undefined {
  let total: number | undefined;
  for (const step of steps) {
    const output = step.output;
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      const count = (output as Record<string, unknown>).toolCallCount;
      if (typeof count === 'number') total = (total ?? 0) + count;
    }
  }
  return total;
}

function toolCallNames(steps: Step[]): string[] {
  const names = new Set<string>();
  for (const step of steps) {
    const output = step.output;
    if (!output || typeof output !== 'object' || Array.isArray(output)) continue;
    const calls = (output as Record<string, unknown>).toolCalls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!call || typeof call !== 'object' || Array.isArray(call)) continue;
      const tool = (call as Record<string, unknown>).tool;
      if (typeof tool === 'string') names.add(tool);
    }
  }
  return [...names];
}

function metricsFor(
  nodeId: string,
  steps: Step[],
  egress: EgressEvent[],
  decisions: ScheduleDecision[],
  now: number,
): NodeMetrics {
  const stepIds = new Set(steps.map((s) => s.id));
  const rows = egress.filter((e) => e.stepId !== undefined && stepIds.has(e.stepId));
  const mine = decisions.filter((d) => stepIds.has(d.stepId));

  const toolsAvailable = mine.reduce((sum, d) => sum + d.availableTools.length, 0);
  const toolsExposed = mine.reduce((sum, d) => sum + d.exposedTools.length, 0);
  const exposedToolNames = [...new Set(mine.flatMap((d) => d.exposedTools))];
  const calledToolNames = toolCallNames(steps);
  const toolDivergence = calledToolNames.filter((name) => !exposedToolNames.includes(name));

  return {
    nodeId,
    // A swarm's parent carries the node's label; children are per-worker.
    label: steps.find((s) => s.parentStepId === null)?.label ?? steps[0]?.label,
    stepIds: steps.map((s) => s.id),
    status: worstStatus(steps),
    wallMs: spanMs(steps, now),
    providerLatencyMs: rows.reduce((sum, e) => sum + (e.latencyMs ?? 0), 0),
    // Token presence is the honest test for "was a model involved": tool,
    // fetch and browser calls report latency but no tokens, so they don't count.
    llmCalls: rows.filter((e) => (e.tokensIn ?? 0) > 0 || (e.tokensOut ?? 0) > 0).length,
    tokensIn: rows.reduce((sum, e) => sum + (e.tokensIn ?? 0), 0),
    tokensOut: rows.reduce((sum, e) => sum + (e.tokensOut ?? 0), 0),
    estimatedCostCents: rows.reduce((sum, e) => sum + (e.estimatedCostCents ?? 0), 0),
    toolsAvailable: mine.length > 0 ? toolsAvailable : undefined,
    toolsExposed: mine.length > 0 ? toolsExposed : undefined,
    toolCallsActual: toolCallCount(steps),
    modelTier: mine[0]?.modelTier,
    exposedToolNames: mine.length > 0 ? exposedToolNames : undefined,
    calledToolNames: calledToolNames.length > 0 ? calledToolNames : undefined,
    toolDivergence: toolDivergence.length > 0 ? toolDivergence : undefined,
  };
}

/**
 * Roll a run up into per-node and total metrics.
 *
 * `now` is injectable so a running run gets a live wallMs while tests stay
 * deterministic — same approach as `duration()` in the web app's lib/format.ts.
 */
export function rollup(input: RollupInput, now: number = Date.now()): RunAnalytics {
  const { run, steps, egress } = input;
  const decisions = input.scheduleDecisions ?? [];
  const approvals = input.approvals ?? [];

  const byNode = new Map<string, Step[]>();
  const orphans: Step[] = [];

  for (const step of steps) {
    if (step.nodeId === undefined) {
      orphans.push(step);
      continue;
    }
    const list = byNode.get(step.nodeId);
    if (list) list.push(step);
    else byNode.set(step.nodeId, [step]);
  }

  const nodes = [...byNode.entries()].map(([nodeId, nodeSteps]) =>
    metricsFor(nodeId, nodeSteps, egress, decisions, now),
  );

  const unattributed = orphans.length > 0 ? metricsFor('', orphans, egress, decisions, now) : null;

  const egressSummary = summarise(egress);
  const wallMs =
    spanMs(steps, now) || Math.max(0, (ms(run.updatedAt) ?? now) - (ms(run.createdAt) ?? now));
  const providerLatencyMs = egress.reduce((sum, e) => sum + (e.latencyMs ?? 0), 0);

  const toolsAvailable = decisions.reduce((sum, d) => sum + d.availableTools.length, 0);
  const toolsExposed = decisions.reduce((sum, d) => sum + d.exposedTools.length, 0);

  return {
    runId: run.id,
    kind: run.kind,
    status: run.status,
    nodes,
    unattributed,
    totals: {
      wallMs,
      providerLatencyMs,
      parallelismFactor: wallMs > 0 ? providerLatencyMs / wallMs : 0,
      llmCalls: egress.filter((e) => (e.tokensIn ?? 0) > 0 || (e.tokensOut ?? 0) > 0).length,
      tokensIn: egressSummary.totalTokensIn,
      tokensOut: egressSummary.totalTokensOut,
      estimatedCostCents: egressSummary.estimatedCostCents,
      stepCount: steps.length,
      nodeCount: nodes.length,
      approvals: approvals.length,
      approvalsPending: approvals.filter((a) => a.status === 'pending').length,
      toolsAvailable,
      toolsExposed,
      toolReductionRatio: toolsAvailable > 0 ? toolsExposed / toolsAvailable : 0,
      egress: egressSummary,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

export interface AssertionResult {
  id: string;
  description: string;
  expected: string;
  actual: string | null;
  passed: boolean;
}

function walkPath(value: unknown, segments: string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Evaluate graph assertions against persisted step outputs. */
export function evaluateAssertions(assertions: GraphAssertion[], steps: Step[]): AssertionResult[] {
  const byNode = new Map<string, Step>();
  for (const step of steps) {
    if (step.nodeId !== undefined && !byNode.has(step.nodeId)) byNode.set(step.nodeId, step);
  }

  return assertions.map((assertion) => {
    const [root, nodeId, ...rest] = assertion.path.split('.');
    const step = root === 'nodes' && nodeId !== undefined ? byNode.get(nodeId) : undefined;
    const resolved = step ? walkPath(step.output, rest) : undefined;
    const actual = resolved === undefined ? null : String(resolved);
    return {
      id: assertion.id,
      description: assertion.description,
      expected: assertion.expected,
      actual,
      passed: actual !== null && actual === assertion.expected,
    };
  });
}
