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

import type { Approval, EgressEvent, Json, PauseSpan, Run, Step, StepStatus } from './domain.js';
import { emptyRunView, type RunView, type StoredEvent } from './events.js';
import type { ControlDecisionRecord, ModelLifecycleEvent, ToolLifecycleEvent } from './control.js';
import type { ModelTier } from './providers.js';
import type { AgentGraph, GraphAssertion } from './schemas/graph.js';
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

/** First start and last end (or `now` if still open) across a set of steps. */
function spanBounds(steps: Step[], now: number): { first: number; last: number } | null {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;

  for (const step of steps) {
    const started = ms(step.startedAt);
    if (started !== null && started < first) first = started;
    // An unfinished step runs up to `now`, so a live run reports a growing wallMs.
    const ended = ms(step.endedAt) ?? (started !== null ? now : null);
    if (ended !== null && ended > last) last = ended;
  }

  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return { first, last };
}

/** Elapsed across a set of steps: last end (or `now` if still open) minus first start. */
function spanMs(steps: Step[], now: number): number {
  const bounds = spanBounds(steps, now);
  return bounds ? Math.max(0, bounds.last - bounds.first) : 0;
}

/**
 * How much of [from, to] a run spent paused.
 *
 * Only the OVERLAP counts. A pause before the first step or after the last one
 * lies outside the span the steps cover, and subtracting it would understate
 * the run. An open pause runs up to `now`.
 */
export function pausedOverlapMs(
  pauses: PauseSpan[] | undefined,
  from: number,
  to: number,
  now: number,
): number {
  if (!pauses || pauses.length === 0) return 0;
  let total = 0;
  for (const pause of pauses) {
    const start = ms(pause.at);
    if (start === null) continue;
    const end = ms(pause.resumedAt) ?? now;
    total += Math.max(0, Math.min(end, to) - Math.max(start, from));
  }
  return total;
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
  // Paused time is excluded: a run left paused for an hour did not take an hour,
  // and counting it would wreck the parallelism factor (provider time / wall time),
  // which is a headline number.
  const bounds = spanBounds(steps, now);
  const activeSpan = bounds
    ? Math.max(
        0,
        bounds.last - bounds.first - pausedOverlapMs(run.pauses, bounds.first, bounds.last, now),
      )
    : 0;
  const wallMs = activeSpan || Math.max(0, (ms(run.updatedAt) ?? now) - (ms(run.createdAt) ?? now));
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
/* Event-derived metrics V2                                                   */
/* -------------------------------------------------------------------------- */

/** How a displayed metric was obtained. Unknown is deliberately not zero. */
export type MetricSource = 'provider_reported' | 'estimated' | 'derived' | 'mixed' | 'unavailable';

/** Coverage is call-based: how many observable activities supplied this value. */
export interface MetricCoverage {
  known: number;
  total: number;
  /** `1` for an empty population; there is no missing observation. */
  ratio: number;
  complete: boolean;
}

/**
 * A number plus enough provenance to render it honestly.
 *
 * `value: null` means unknown. A reported zero remains `value: 0`, so callers
 * never need to use zero as a stand-in for missing provider telemetry.
 */
export interface MeasuredMetric {
  value: number | null;
  unit: 'count' | 'ms' | 'tokens' | 'cents';
  source: MetricSource;
  coverage: MetricCoverage;
}

export interface UsageSliceV2 {
  /** Unique logical calls/activities, never inferred from token presence. */
  calls: number;
  tokensIn: MeasuredMetric;
  tokensOut: MeasuredMetric;
  totalTokens: MeasuredMetric;
  estimatedCostCents: MeasuredMetric;
}

export interface ModelCallMetricsV2 {
  /** Unique `modelCallId` values in model.lifecycle. */
  agent: number;
  /** Actual Jev provider calls evidenced by non-housekeeping egress rows. */
  jev: number;
  total: number;
  local: number;
  cloud: number;
  completed: number;
  failed: number;
  inFlight: number;
}

export interface UsageMetricsV2 {
  modelCalls: ModelCallMetricsV2;
  agentModels: UsageSliceV2;
  jev: UsageSliceV2;
  /** Non-model provider activity, excluding Hermes polling/housekeeping. */
  otherProviders: UsageSliceV2;
  total: UsageSliceV2;
}

export interface TimingMetricsV2 {
  /** Run creation to terminal update (or `now` for a live run). */
  wallMs: MeasuredMetric;
  /** Step execution span less recorded pause and approval-wait intervals. */
  activeExecutionMs: MeasuredMetric;
  pausedMs: MeasuredMetric;
  approvalWaitMs: MeasuredMetric;
  /** Reserved until a typed lifecycle identifies other queue/provider waits. */
  otherWaitMs: MeasuredMetric;
  providerLatencyMs: MeasuredMetric;
}

export interface ToolMetricsV2 {
  /** Sum across bounded select-tools decisions (or schedule fallback). */
  candidates: number;
  /** Sum across bounded select-tools decisions (or schedule fallback). */
  exposed: number;
  /** Unique exact action IDs reaching each lifecycle phase. */
  proposed: number;
  executed: number;
  succeeded: number;
  blocked: number;
  failed: number;
  candidateSource: 'control_decision' | 'schedule_decision' | 'unavailable';
}

export interface ApprovalMetricsV2 {
  requested: number;
  pending: number;
  approved: number;
  rejected: number;
  revised: number;
}

export interface NodeAnalyticsV2 {
  /** `null` is the explicit unattributed bucket. */
  nodeId: string | null;
  stepIds: string[];
  usage: UsageMetricsV2;
  timing: TimingMetricsV2;
  tools: ToolMetricsV2;
}

export interface RunAnalyticsV2 {
  version: 2;
  source: 'event_ledger';
  /** Highest persisted event sequence included in this projection. */
  lastSeq: number;
  runId: string | null;
  status: string | null;
  usage: UsageMetricsV2;
  timing: TimingMetricsV2;
  tools: ToolMetricsV2;
  approvals: ApprovalMetricsV2;
  nodes: NodeAnalyticsV2[];
}

function upsertById<T extends { id: string }>(list: T[], item: T): void {
  const index = list.findIndex((value) => value.id === item.id);
  if (index === -1) list.push(item);
  else list[index] = item;
}

/**
 * Rebuild the canonical analytics input from persisted events.
 *
 * This mirrors the SSE reducer, but is shared so the API and browser cannot
 * silently apply different event semantics. Duplicate replay frames are
 * ignored by `(runId, seq)` before entity upserts are applied.
 */
export function runViewFromStoredEvents(events: readonly StoredEvent[]): RunView {
  const view: RunView = {
    ...emptyRunView,
    steps: [],
    approvals: [],
    egress: [],
    piiSpans: [],
    scheduleDecisions: [],
    browserSessions: [],
    controlDecisions: [],
    modelCalls: [],
    harnessTurns: [],
    toolLifecycle: [],
    agentSessions: [],
    logs: [],
  };
  const seenFrames = new Set<string>();

  for (const stored of [...events].sort((a, b) => a.seq - b.seq)) {
    const frameKey = `${stored.runId}:${stored.seq}`;
    if (seenFrames.has(frameKey)) continue;
    seenFrames.add(frameKey);
    view.lastSeq = Math.max(view.lastSeq, stored.seq);
    const event = stored.event;
    switch (event.type) {
      case 'run.updated':
        view.run = event.run;
        break;
      case 'step.upserted':
        upsertById(view.steps, event.step);
        view.steps.sort((a, b) => a.seq - b.seq);
        break;
      case 'approval.requested':
      case 'approval.resolved':
        upsertById(view.approvals, event.approval);
        break;
      case 'egress.logged':
        upsertById(view.egress, event.egress);
        break;
      case 'pii.detected':
        upsertById(view.piiSpans, event.span);
        break;
      case 'schedule.decided':
        upsertById(view.scheduleDecisions, event.decision);
        break;
      case 'browser.session.opened': {
        const index = view.browserSessions.findIndex(
          (session) => session.sessionId === event.session.sessionId,
        );
        if (index === -1) view.browserSessions.push(event.session);
        else view.browserSessions[index] = { ...view.browserSessions[index], ...event.session };
        break;
      }
      case 'browser.session.closed': {
        const index = view.browserSessions.findIndex(
          (value) => value.sessionId === event.sessionId,
        );
        if (index !== -1) {
          view.browserSessions[index] = { ...view.browserSessions[index]!, closedAt: event.at };
        }
        break;
      }
      case 'control.decided':
        upsertById(view.controlDecisions, event.decision);
        break;
      case 'model.lifecycle':
        upsertById(view.modelCalls, event.lifecycle);
        break;
      case 'harness.turn':
        upsertById(view.harnessTurns, event.turn);
        break;
      case 'tool.lifecycle':
        upsertById(view.toolLifecycle, event.lifecycle);
        break;
      case 'session.updated':
        upsertById(view.agentSessions, event.session);
        break;
      case 'log':
        view.logs.push({ level: event.level, message: event.message, at: event.at });
        break;
    }
  }
  return view;
}

interface MetricRows {
  calls: number;
  rows: EgressEvent[];
}

function coverage(known: number, total: number): MetricCoverage {
  const boundedKnown = Math.min(Math.max(0, known), Math.max(0, total));
  return {
    known: boundedKnown,
    total,
    ratio: total === 0 ? 1 : boundedKnown / total,
    complete: boundedKnown === total,
  };
}

function measuredFromRows(
  input: MetricRows,
  key: 'tokensIn' | 'tokensOut' | 'estimatedCostCents',
): MeasuredMetric {
  const withValue = input.rows.filter((row) => typeof row[key] === 'number');
  const observed = withValue.reduce((sum, row) => sum + (row[key] ?? 0), 0);
  const metricCoverage = coverage(withValue.length, input.calls);
  if (input.calls === 0) {
    return {
      value: 0,
      unit: key === 'estimatedCostCents' ? 'cents' : 'tokens',
      source: 'derived',
      coverage: metricCoverage,
    };
  }
  return {
    value: withValue.length === 0 ? null : observed,
    unit: key === 'estimatedCostCents' ? 'cents' : 'tokens',
    source:
      withValue.length === 0
        ? 'unavailable'
        : key === 'estimatedCostCents'
          ? 'estimated'
          : 'provider_reported',
    coverage: metricCoverage,
  };
}

function measuredTotalTokens(input: MetricRows): MeasuredMetric {
  const withValue = input.rows.filter(
    (row) => typeof row.tokensIn === 'number' && typeof row.tokensOut === 'number',
  );
  const metricCoverage = coverage(withValue.length, input.calls);
  return {
    value:
      withValue.length === 0 && input.calls > 0
        ? null
        : withValue.reduce((sum, row) => sum + row.tokensIn! + row.tokensOut!, 0),
    unit: 'tokens',
    source:
      withValue.length === 0 && input.calls > 0
        ? 'unavailable'
        : input.calls === 0
          ? 'derived'
          : 'provider_reported',
    coverage: metricCoverage,
  };
}

function combineMetrics(metrics: MeasuredMetric[], unit: MeasuredMetric['unit']): MeasuredMetric {
  const total = metrics.reduce((sum, metric) => sum + metric.coverage.total, 0);
  const known = metrics.reduce((sum, metric) => sum + metric.coverage.known, 0);
  // An empty slice's derived zero is mathematically useful, but it must not
  // turn a provider-reported aggregate into a misleading `mixed` source.
  const contributors =
    total === 0 ? metrics : metrics.filter((metric) => metric.coverage.total > 0);
  const values = contributors.filter((metric) => metric.value !== null);
  const sources = new Set(values.map((metric) => metric.source));
  return {
    value:
      values.length === 0 && total > 0
        ? null
        : values.reduce((sum, metric) => sum + metric.value!, 0),
    unit,
    source:
      values.length === 0 && total > 0
        ? 'unavailable'
        : sources.size === 0
          ? 'derived'
          : sources.size === 1
            ? values[0]!.source
            : 'mixed',
    coverage: coverage(known, total),
  };
}

function usageSlice(input: MetricRows): UsageSliceV2 {
  const tokensIn = measuredFromRows(input, 'tokensIn');
  const tokensOut = measuredFromRows(input, 'tokensOut');
  return {
    calls: input.calls,
    tokensIn,
    tokensOut,
    totalTokens: measuredTotalTokens(input),
    estimatedCostCents: measuredFromRows(input, 'estimatedCostCents'),
  };
}

function uniqueModelCalls(events: ModelLifecycleEvent[]): Map<string, ModelLifecycleEvent> {
  const calls = new Map<string, ModelLifecycleEvent>();
  for (const event of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const previous = calls.get(event.modelCallId);
    // A terminal fact wins over a late/replayed requested event.
    if (!previous || previous.phase === 'requested' || event.phase !== 'requested') {
      calls.set(event.modelCallId, event);
    }
  }
  return calls;
}

function isHermesHousekeeping(event: EgressEvent): boolean {
  return event.providerId === 'hermes' && event.op === 'pollTask';
}

function usageMetrics(modelEvents: ModelLifecycleEvent[], egress: EgressEvent[]): UsageMetricsV2 {
  const modelCalls = uniqueModelCalls(modelEvents);
  const agentCalls = [...modelCalls.values()];
  const agentProviders = new Set(agentCalls.map((call) => call.providerId));
  const visibleEgress = egress.filter((event) => !isHermesHousekeeping(event));
  const jevRows = visibleEgress.filter((event) => event.providerId === 'jev');
  // A persisted Jev control decision describes the final recommendation, not
  // necessarily one remote call (deterministic overrides and batched questions
  // exist). The egress row is the authoritative evidence that Jev actually ran.
  const jevCalls = jevRows.length;
  const agentRows = visibleEgress.filter(
    (event) => event.providerId !== 'jev' && agentProviders.has(event.providerId),
  );
  const otherRows = visibleEgress.filter(
    (event) => event.providerId !== 'jev' && !agentProviders.has(event.providerId),
  );

  const agent = usageSlice({ calls: agentCalls.length, rows: agentRows });
  const jev = usageSlice({ calls: jevCalls, rows: jevRows });
  const otherProviders = usageSlice({ calls: otherRows.length, rows: otherRows });
  const total: UsageSliceV2 = {
    calls: agent.calls + jev.calls + otherProviders.calls,
    tokensIn: combineMetrics([agent.tokensIn, jev.tokensIn, otherProviders.tokensIn], 'tokens'),
    tokensOut: combineMetrics([agent.tokensOut, jev.tokensOut, otherProviders.tokensOut], 'tokens'),
    totalTokens: combineMetrics(
      [agent.totalTokens, jev.totalTokens, otherProviders.totalTokens],
      'tokens',
    ),
    estimatedCostCents: combineMetrics(
      [agent.estimatedCostCents, jev.estimatedCostCents, otherProviders.estimatedCostCents],
      'cents',
    ),
  };

  return {
    modelCalls: {
      agent: agentCalls.length,
      jev: jevCalls,
      total: agentCalls.length + jevCalls,
      local: agentCalls.filter((call) => call.providerId === 'ollama').length,
      cloud: agentCalls.filter((call) => call.providerId !== 'ollama').length,
      completed: agentCalls.filter((call) => call.phase === 'completed').length,
      failed: agentCalls.filter((call) => call.phase === 'failed').length,
      inFlight: agentCalls.filter((call) => call.phase === 'requested').length,
    },
    agentModels: agent,
    jev,
    otherProviders,
    total,
  };
}

interface Interval {
  from: number;
  to: number;
}

function intervalUnionMs(intervals: Interval[]): number {
  const sorted = intervals
    .filter((interval) => interval.to > interval.from)
    .sort((a, b) => a.from - b.from);
  if (sorted.length === 0) return 0;
  let total = 0;
  let current = { ...sorted[0]! };
  for (const interval of sorted.slice(1)) {
    if (interval.from <= current.to) current.to = Math.max(current.to, interval.to);
    else {
      total += current.to - current.from;
      current = { ...interval };
    }
  }
  return total + current.to - current.from;
}

function boundedIntervals(intervals: Interval[], from: number, to: number): Interval[] {
  return intervals
    .map((interval) => ({ from: Math.max(from, interval.from), to: Math.min(to, interval.to) }))
    .filter((interval) => interval.to > interval.from);
}

function knownTime(value: number, source: MetricSource = 'derived'): MeasuredMetric {
  return { value, unit: 'ms', source, coverage: coverage(1, 1) };
}

function unknownTime(): MeasuredMetric {
  return { value: null, unit: 'ms', source: 'unavailable', coverage: coverage(0, 1) };
}

function timingMetrics(
  run: Run | null,
  steps: Step[],
  approvals: Approval[],
  egress: EgressEvent[],
  now: number,
  scope: 'run' | 'steps' = 'run',
): TimingMetricsV2 {
  const bounds = spanBounds(steps, now);
  const createdAt = ms(run?.createdAt);
  const terminalAt = run && isTerminalStatus(run.status) ? ms(run.updatedAt) : now;
  const wall =
    scope === 'run' && createdAt !== null && terminalAt !== null
      ? Math.max(0, terminalAt - createdAt)
      : bounds
        ? Math.max(0, bounds.last - bounds.first)
        : null;
  const waitEnd = terminalAt ?? now;
  const pauseIntervals =
    run?.pauses?.flatMap((pause) => {
      const from = ms(pause.at);
      const to = ms(pause.resumedAt) ?? waitEnd;
      return from === null ? [] : [{ from, to }];
    }) ?? [];
  const approvalIntervals = approvals.flatMap((approval) => {
    const from = ms(approval.createdAt);
    const to = ms(approval.decidedAt) ?? waitEnd;
    return from === null ? [] : [{ from, to }];
  });
  const metricPauseIntervals =
    scope === 'steps' && bounds
      ? boundedIntervals(pauseIntervals, bounds.first, bounds.last)
      : pauseIntervals;
  const metricApprovalIntervals =
    scope === 'steps' && bounds
      ? boundedIntervals(approvalIntervals, bounds.first, bounds.last)
      : approvalIntervals;
  // New runs explicitly start with `pauses: []`. Absence therefore identifies
  // legacy history whose pause coverage cannot be proven complete.
  const paused = run?.pauses === undefined ? null : intervalUnionMs(metricPauseIntervals);
  const approvalWait = intervalUnionMs(metricApprovalIntervals);
  const inactiveWithinSteps = bounds
    ? intervalUnionMs(
        boundedIntervals([...pauseIntervals, ...approvalIntervals], bounds.first, bounds.last),
      )
    : null;
  const active =
    bounds && inactiveWithinSteps !== null && paused !== null
      ? Math.max(0, bounds.last - bounds.first - inactiveWithinSteps)
      : null;
  const visibleEgress = egress.filter((event) => !isHermesHousekeeping(event));
  const providerLatencies = visibleEgress.filter((event) => typeof event.latencyMs === 'number');

  return {
    wallMs: wall === null ? unknownTime() : knownTime(wall),
    activeExecutionMs: active === null ? unknownTime() : knownTime(active),
    pausedMs: paused === null ? unknownTime() : knownTime(paused),
    approvalWaitMs: knownTime(approvalWait),
    otherWaitMs: unknownTime(),
    providerLatencyMs: {
      value:
        providerLatencies.length === 0 && visibleEgress.length > 0
          ? null
          : providerLatencies.reduce((sum, event) => sum + (event.latencyMs ?? 0), 0),
      unit: 'ms',
      source:
        providerLatencies.length === 0 && visibleEgress.length > 0
          ? 'unavailable'
          : 'provider_reported',
      coverage: coverage(providerLatencies.length, visibleEgress.length),
    },
  };
}

function isTerminalStatus(status: Run['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function toolMetrics(
  decisions: ControlDecisionRecord[],
  schedules: ScheduleDecision[],
  lifecycle: ToolLifecycleEvent[],
): ToolMetricsV2 {
  const selections = decisions.filter((decision) => decision.operation === 'select_tools');
  const candidateSource =
    selections.length > 0
      ? 'control_decision'
      : schedules.length > 0
        ? 'schedule_decision'
        : 'unavailable';
  const candidates =
    selections.length > 0
      ? selections.reduce((sum, decision) => sum + (decision.candidateIds?.length ?? 0), 0)
      : schedules.reduce((sum, decision) => sum + decision.availableTools.length, 0);
  const exposed =
    selections.length > 0
      ? selections.reduce((sum, decision) => sum + (decision.selectedIds?.length ?? 0), 0)
      : schedules.reduce((sum, decision) => sum + decision.exposedTools.length, 0);
  const actionsAt = (phases: ToolLifecycleEvent['phase'][]): number =>
    new Set(
      lifecycle.filter((event) => phases.includes(event.phase)).map((event) => event.action.id),
    ).size;

  return {
    candidates,
    exposed,
    proposed: actionsAt(['proposed']),
    executed: actionsAt(['executing', 'succeeded', 'failed']),
    succeeded: actionsAt(['succeeded']),
    blocked: actionsAt(['blocked']),
    failed: actionsAt(['failed']),
    candidateSource,
  };
}

function approvalMetrics(approvals: Approval[]): ApprovalMetricsV2 {
  return {
    requested: approvals.length,
    pending: approvals.filter((approval) => approval.status === 'pending').length,
    approved: approvals.filter((approval) => approval.status === 'approved').length,
    rejected: approvals.filter((approval) => approval.status === 'rejected').length,
    revised: approvals.filter((approval) => approval.status === 'revised').length,
  };
}

/**
 * Authoritative event-derived run metrics for new UI/API surfaces.
 *
 * Keep `rollup()` for compatibility. New code should use this contract so
 * model calls are lifecycle-counted and missing provider telemetry remains
 * visible instead of being silently rendered as zero.
 */
export function rollupV2(view: RunView, now: number = Date.now()): RunAnalyticsV2 {
  const stepsByNode = new Map<string | null, Step[]>();
  for (const step of view.steps) {
    const nodeId = step.nodeId ?? null;
    const entries = stepsByNode.get(nodeId) ?? [];
    entries.push(step);
    stepsByNode.set(nodeId, entries);
  }
  const nodes: NodeAnalyticsV2[] = [...stepsByNode.entries()].map(([nodeId, steps]) => {
    const stepIds = new Set(steps.map((step) => step.id));
    const egress = view.egress.filter((event) => event.stepId && stepIds.has(event.stepId));
    const decisions = view.controlDecisions.filter(
      (decision) => decision.stepId && stepIds.has(decision.stepId),
    );
    const models = view.modelCalls.filter((event) => event.stepId && stepIds.has(event.stepId));
    const tools = view.toolLifecycle.filter((event) => stepIds.has(event.stepId));
    const schedules = view.scheduleDecisions.filter((decision) => stepIds.has(decision.stepId));
    const approvals = view.approvals.filter((approval) => stepIds.has(approval.stepId));
    return {
      nodeId,
      stepIds: [...stepIds],
      usage: usageMetrics(models, egress),
      timing: timingMetrics(view.run, steps, approvals, egress, now, 'steps'),
      tools: toolMetrics(decisions, schedules, tools),
    };
  });

  return {
    version: 2,
    source: 'event_ledger',
    lastSeq: view.lastSeq,
    runId: view.run?.id ?? null,
    status: view.run?.status ?? null,
    usage: usageMetrics(view.modelCalls, view.egress),
    timing: timingMetrics(view.run, view.steps, view.approvals, view.egress, now),
    tools: toolMetrics(view.controlDecisions, view.scheduleDecisions, view.toolLifecycle),
    approvals: approvalMetrics(view.approvals),
    nodes,
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

/* -------------------------------------------------------------------------- */
/* Graph critique — feeds a graph's own run history back to the synthesiser   */
/* -------------------------------------------------------------------------- */

type ByRun<T> = Map<string, T[]> | Record<string, T[]>;

function lookupByRun<T>(map: ByRun<T> | undefined, runId: string): T[] {
  if (!map) return [];
  return map instanceof Map ? (map.get(runId) ?? []) : (map[runId] ?? []);
}

export interface BuildGraphCritiqueInput {
  graph: AgentGraph;
  runs: Run[];
  stepsByRun: ByRun<Step>;
  /** rollup() needs the egress ledger for tokens/cost/latency per node. */
  egressByRun?: ByRun<EgressEvent>;
  scheduleDecisionsByRun?: ByRun<ScheduleDecision>;
  approvalsByRun?: ByRun<Approval>;
  /** Same-graph `baseline`-playbook runs, for the cost/latency/token comparison. */
  baselineRuns?: Run[];
  baselineStepsByRun?: ByRun<Step>;
  baselineEgressByRun?: ByRun<EgressEvent>;
}

export interface AssertionRate {
  id: string;
  description: string;
  passed: number;
  total: number;
}

export interface NodeOutlier {
  nodeId: string;
  label?: string;
  runId: string;
  value: number;
  median: number;
}

export interface ToolDivergenceOutlier {
  nodeId: string;
  label?: string;
  runId: string;
  tools: string[];
}

/** A failed agent_task step's self-reported partial progress, when present. */
export interface FailureEvidence {
  runId: string;
  stepId: string;
  nodeId?: string;
  toolCallCount?: number;
  toolCalls?: Json;
}

export interface BaselineComparison {
  baselineRunsAnalyzed: number;
  medianTokens: { graph: number; baseline: number };
  medianCostCents: { graph: number; baseline: number };
  medianLatencyMs: { graph: number; baseline: number };
}

export interface GraphCritique {
  graphId: string;
  runsAnalyzed: number;
  /** Fewer than 3 runs analysed — treat every finding below as a hunch, not a trend. */
  lowConfidence: boolean;
  assertionFailures: AssertionRate[];
  costOutliers: NodeOutlier[];
  latencyOutliers: NodeOutlier[];
  toolDivergenceOutliers: ToolDivergenceOutlier[];
  failureEvidence: FailureEvidence[];
  baselineComparison?: BaselineComparison;
}

/**
 * A node's cost/latency counts as an outlier only when it clears BOTH bars: a
 * relative jump over its OWN median across the analysed runs, and an absolute
 * floor so noise on a near-free node (2 cents vs a median of 1) never reports
 * as "a 2x outlier".
 */
const OUTLIER_RATIO = 1.5;
const COST_OUTLIER_FLOOR_CENTS = 5;
const LATENCY_OUTLIER_FLOOR_MS = 500;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Feed a graph's own run results back to the synthesiser as a critique it can
 * act on. PURE — no store access, no provider call. The caller (optimization
 * service) does the fetching; this just reduces what it hands over.
 */
export function buildGraphCritique(input: BuildGraphCritiqueInput): GraphCritique {
  const { graph, runs } = input;

  const bundles: RollupInput[] = runs.map((run) => ({
    run,
    steps: lookupByRun(input.stepsByRun, run.id),
    egress: lookupByRun(input.egressByRun, run.id),
    scheduleDecisions: lookupByRun(input.scheduleDecisionsByRun, run.id),
    approvals: lookupByRun(input.approvalsByRun, run.id),
  }));
  const analyzed = bundles.map((bundle) => ({
    run: bundle.run,
    steps: bundle.steps,
    analytics: rollup(bundle),
  }));

  // Assertions: pass/total per assertion id, across every analysed run.
  const assertions = graph.assertions ?? [];
  const tally = new Map<string, { description: string; passed: number; total: number }>();
  for (const { steps } of analyzed) {
    for (const result of evaluateAssertions(assertions, steps)) {
      const entry = tally.get(result.id) ?? {
        description: result.description,
        passed: 0,
        total: 0,
      };
      entry.total += 1;
      if (result.passed) entry.passed += 1;
      tally.set(result.id, entry);
    }
  }
  const assertionFailures: AssertionRate[] = [...tally.entries()]
    .filter(([, t]) => t.passed < t.total)
    .map(([id, t]) => ({ id, description: t.description, passed: t.passed, total: t.total }));

  // Per-node cost/latency/tool-divergence, grouped so each node is judged
  // against its OWN history rather than against every other node's scale.
  const byNode = new Map<
    string,
    { runId: string; cost: number; latency: number; label?: string; toolDivergence?: string[] }[]
  >();
  for (const { run, analytics } of analyzed) {
    for (const node of analytics.nodes) {
      if (!node.nodeId) continue;
      const list = byNode.get(node.nodeId) ?? [];
      list.push({
        runId: run.id,
        cost: node.estimatedCostCents,
        latency: node.wallMs,
        label: node.label,
        toolDivergence: node.toolDivergence,
      });
      byNode.set(node.nodeId, list);
    }
  }

  const costOutliers: NodeOutlier[] = [];
  const latencyOutliers: NodeOutlier[] = [];
  const toolDivergenceOutliers: ToolDivergenceOutlier[] = [];

  for (const [nodeId, samples] of byNode) {
    const costMedian = median(samples.map((s) => s.cost));
    const latencyMedian = median(samples.map((s) => s.latency));
    for (const sample of samples) {
      if (sample.cost > costMedian * OUTLIER_RATIO && sample.cost > COST_OUTLIER_FLOOR_CENTS) {
        costOutliers.push({
          nodeId,
          label: sample.label,
          runId: sample.runId,
          value: sample.cost,
          median: costMedian,
        });
      }
      if (
        sample.latency > latencyMedian * OUTLIER_RATIO &&
        sample.latency > LATENCY_OUTLIER_FLOOR_MS
      ) {
        latencyOutliers.push({
          nodeId,
          label: sample.label,
          runId: sample.runId,
          value: sample.latency,
          median: latencyMedian,
        });
      }
      if (sample.toolDivergence && sample.toolDivergence.length > 0) {
        toolDivergenceOutliers.push({
          nodeId,
          label: sample.label,
          runId: sample.runId,
          tools: sample.toolDivergence,
        });
      }
    }
  }

  // A failed agent_task's output MAY carry partial progress the harness
  // reported before it died -- surface it as evidence when it is there.
  const failureEvidence: FailureEvidence[] = [];
  for (const { run, steps } of analyzed) {
    for (const step of steps) {
      if (step.status !== 'failed' || step.kind !== 'agent_task') continue;
      const output = step.output;
      if (!output || typeof output !== 'object' || Array.isArray(output)) continue;
      const record = output as Record<string, unknown>;
      if (record.partial !== true) continue;
      failureEvidence.push({
        runId: run.id,
        stepId: step.id,
        nodeId: step.nodeId,
        toolCallCount: typeof record.toolCallCount === 'number' ? record.toolCallCount : undefined,
        toolCalls: 'toolCalls' in record ? (record.toolCalls as Json) : undefined,
      });
    }
  }

  // Baseline comparison: same-graph naive-run medians vs this graph's medians.
  let baselineComparison: BaselineComparison | undefined;
  if (input.baselineRuns && input.baselineRuns.length > 0) {
    const baselineAnalytics = input.baselineRuns.map((run) =>
      rollup({
        run,
        steps: lookupByRun(input.baselineStepsByRun, run.id),
        egress: lookupByRun(input.baselineEgressByRun, run.id),
      }),
    );
    const graphTokens = analyzed.map(
      (a) => a.analytics.totals.tokensIn + a.analytics.totals.tokensOut,
    );
    const baselineTokens = baselineAnalytics.map((a) => a.totals.tokensIn + a.totals.tokensOut);

    baselineComparison = {
      baselineRunsAnalyzed: input.baselineRuns.length,
      medianTokens: { graph: median(graphTokens), baseline: median(baselineTokens) },
      medianCostCents: {
        graph: median(analyzed.map((a) => a.analytics.totals.estimatedCostCents)),
        baseline: median(baselineAnalytics.map((a) => a.totals.estimatedCostCents)),
      },
      medianLatencyMs: {
        graph: median(analyzed.map((a) => a.analytics.totals.wallMs)),
        baseline: median(baselineAnalytics.map((a) => a.totals.wallMs)),
      },
    };
  }

  return {
    graphId: graph.id,
    runsAnalyzed: runs.length,
    lowConfidence: runs.length < 3,
    assertionFailures,
    costOutliers,
    latencyOutliers,
    toolDivergenceOutliers,
    failureEvidence,
    baselineComparison,
  };
}
