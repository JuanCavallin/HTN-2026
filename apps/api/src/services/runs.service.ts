/**
 * Run use-cases. The transaction boundary between HTTP and the orchestrator.
 *
 * Key behaviour: createRun persists, emits, and returns IMMEDIATELY. Execution is
 * fire-and-forget; progress reaches the browser over SSE. A route handler must
 * never await a run.
 */

import type {
  AgentGraph,
  Approval,
  EgressEvent,
  Json,
  PiiSpan,
  Run,
  ScheduleDecision,
  Step,
} from '@htn/shared';
import { isTerminal, stripPiiValue } from '@htn/shared';
import { getPlaybook, listPlaybooks } from '../core/playbooks/registry.js';
import { forkGraph, GraphNotFoundError } from './graphs.service.js';
import { newId, nowIso } from '../lib/ids.js';
import { NotFoundError, type ListRunsFilter } from '../store/types.js';
import { bus, orchestrator, store } from './runtime.js';

export class ValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Thrown by pauseRun/resumeRun when the run exists but this process is not
 * the one executing it -- already terminal, or started before a restart (see
 * runs.service.ts's own probeStaleRuns for why that leaves debris rather than
 * a run this process could still drive). Distinct from "not found": the run
 * row is real, there is just nothing here to pause or resume.
 */
export class RunNotActiveError extends Error {
  readonly code = 'RUN_NOT_ACTIVE';
  constructor(id: string, verb: 'paused' | 'resumed') {
    super(
      'Run ' +
        id +
        ' is not currently executing in this process, so it cannot be ' +
        verb +
        ' -- it may already be finished, or this process restarted since it started.',
    );
    this.name = 'RunNotActiveError';
  }
}

export interface RunDetail {
  run: Run;
  steps: Step[];
  approvals: Approval[];
  egress: EgressEvent[];
  /** Values are stripped — the client only ever sees placeholders and classes. */
  piiSpans: PiiSpan[];
  scheduleDecisions: ScheduleDecision[];
}

export function availablePlaybooks(): { kind: string; title: string }[] {
  return listPlaybooks();
}

export async function createRun(args: {
  kind: string;
  input: unknown;
  title?: string;
}): Promise<Run> {
  const playbook = getPlaybook(args.kind);
  if (!playbook) {
    throw new ValidationError('Unknown playbook kind "' + args.kind + '"', {
      available: listPlaybooks().map((p) => p.kind),
    });
  }

  // Validate against the playbook's own schema here, so a bad request is a 400
  // rather than a run that fails a second later.
  const parsed = playbook.inputSchema.safeParse(args.input ?? {});
  if (!parsed.success) {
    throw new ValidationError('Invalid input for playbook "' + args.kind + '"', {
      issues: parsed.error.issues,
    });
  }

  // A graph run SNAPSHOTS the document it is about to execute. Without this,
  // editing a graph would retroactively change what an already-finished run
  // page shows -- the steps would no longer line up with the nodes.
  let input = parsed.data as Json;
  if (args.kind === 'graph') {
    const requested = input as { graphId: string; graphSnapshot?: unknown };
    const graph = await store.getGraph(requested.graphId);
    if (!graph) throw new GraphNotFoundError(requested.graphId);
    input = { ...requested, graphSnapshot: graph } as Json;
  }

  // Hoisted out of `input` into a real column (see Run.graphId) -- any
  // playbook whose input schema happens to carry a `graphId` (graph, baseline,
  // ...) gets its runs linked to that task's lineage for free, with no
  // per-kind special-casing here.
  const graphId =
    typeof (input as { graphId?: unknown }).graphId === 'string'
      ? (input as { graphId: string }).graphId
      : undefined;

  const at = nowIso();
  const run: Run = {
    id: newId('run'),
    kind: args.kind,
    title: args.title ?? (args.kind === 'graph' ? playbookTitleFor(input) : playbook.title),
    status: 'pending',
    input,
    graphId,
    createdAt: at,
    updatedAt: at,
  };

  await store.createRun(run);
  await bus.emit(run.id, { type: 'run.updated', run });

  // Fire and forget. Do NOT await.
  orchestrator.start(run);

  return run;
}

/** A graph run is more useful named after its graph than after the playbook. */
function playbookTitleFor(input: Json): string {
  const snapshot = (input as { graphSnapshot?: { name?: string } }).graphSnapshot;
  return snapshot?.name ?? 'Run an agent graph';
}

export async function listRuns(filter: ListRunsFilter): Promise<Run[]> {
  return store.listRuns(filter);
}

export async function getRun(id: string): Promise<Run | null> {
  return store.getRun(id);
}

export async function getRunDetail(id: string): Promise<RunDetail | null> {
  const run = await store.getRun(id);
  if (!run) return null;

  const [steps, approvals, egress, piiWithValues, scheduleDecisions] = await Promise.all([
    store.listSteps(id),
    store.listApprovals(id),
    store.listEgress(id),
    store.listPiiSpans(id),
    store.listScheduleDecisions(id),
  ]);

  return {
    run,
    steps,
    approvals,
    egress,
    piiSpans: piiWithValues.map(stripPiiValue),
    scheduleDecisions,
  };
}

export async function cancelRun(id: string): Promise<Run | null> {
  const run = await store.getRun(id);
  if (!run) return null;

  const stopped = orchestrator.cancel(id);
  if (!stopped) {
    // Not executing in this process (e.g. after a restart). Mark it terminal
    // rather than leaving a run that will never move again.
    const patched = await store.patchRun(id, { status: 'cancelled', summary: 'Cancelled.' });
    await bus.emit(id, { type: 'run.updated', run: patched });
    return patched;
  }
  // The orchestrator's abort path writes the terminal status and emits.
  return run;
}

/**
 * Pause a run: block new work from starting, let whatever is already in
 * flight finish on its own -- see core/runGate.ts for the full model and why
 * it waits rather than interrupting Hermes mid-turn.
 */
export async function pauseRun(id: string): Promise<Run> {
  const existing = await store.getRun(id);
  if (!existing) throw new NotFoundError('Run', id);
  const run = await orchestrator.pause(id);
  if (!run) throw new RunNotActiveError(id, 'paused');
  return run;
}

/** Resume a paused (or still-draining) run. */
export async function resumeRun(id: string): Promise<Run> {
  const existing = await store.getRun(id);
  if (!existing) throw new NotFoundError('Run', id);
  const run = await orchestrator.resumeRun(id);
  if (!run) throw new RunNotActiveError(id, 'resumed');
  return run;
}

/**
 * Cancel every non-terminal run this process is NOT actually executing.
 *
 * `orchestrator.isRunning()` is exact, not a heuristic: `inFlight` is only
 * ever populated by THIS process's own `execute()`, so right after a boot it
 * is empty and every non-terminal run found is, by construction, orphaned --
 * left "running" forever by a previous process that died (a restart, a
 * crash, a deliberate kill) with no chance to ever mark it terminal itself.
 * A run genuinely still executing in this process is never touched: it IS in
 * `inFlight`, so it's skipped, not raced against.
 *
 * Run automatically at boot (see index.ts) and available on demand via
 * POST /runs/probe-stale, since a restart during development is routine, not
 * exceptional, and each one otherwise leaves debris that looks alarmingly
 * like a real stuck run to anyone looking at the dashboard.
 */
export async function probeStaleRuns(): Promise<{ checked: number; staleIds: string[] }> {
  const all = await store.listRuns({ limit: 1000 });
  const nonTerminal = all.filter((run) => !isTerminal(run.status));
  const stale = nonTerminal.filter((run) => !orchestrator.isRunning(run.id));

  for (const run of stale) {
    await cancelRun(run.id);
  }

  return { checked: nonTerminal.length, staleIds: stale.map((run) => run.id) };
}

/**
 * "Save as a new task": fork the exact graph a run executed into a brand-new,
 * independent graph document. Sourced from the run's own `graphSnapshot`
 * (not a live re-read of the graph by id) so it captures what THIS run
 * actually ran, even if the live document has been edited since.
 */
export async function saveRunAsGraph(runId: string, name?: string): Promise<AgentGraph | null> {
  const run = await store.getRun(runId);
  if (!run) return null;

  if (run.kind !== 'graph') {
    throw new ValidationError(
      'Only a graph run has a graph document to save -- "' + run.kind + '" has none.',
    );
  }
  const snapshot = (run.input as { graphSnapshot?: AgentGraph }).graphSnapshot;
  if (!snapshot) {
    throw new ValidationError('Run "' + runId + '" has no graph snapshot to save.');
  }

  return forkGraph(snapshot, name);
}
