/**
 * Run use-cases. The transaction boundary between HTTP and the orchestrator.
 *
 * Key behaviour: createRun persists, emits, and returns IMMEDIATELY. Execution is
 * fire-and-forget; progress reaches the browser over SSE. A route handler must
 * never await a run.
 */

import type {
  AgentSessionState,
  Approval,
  EgressEvent,
  Json,
  PiiSpan,
  Run,
  ScheduleDecision,
  Step,
  StoredEvent,
} from '@htn/shared';
import { isTerminal, stripPiiValue } from '@htn/shared';
import { pauseRun as gatePauseRun, resumeRun as gateResumeRun } from '../core/pauseGate.js';
import { getPlaybook, listPlaybooks } from '../core/playbooks/registry.js';
import { GraphNotFoundError } from './graphs.service.js';
import { newId, nowIso } from '../lib/ids.js';
import type { ListRunsFilter } from '../store/types.js';
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

export interface RunDetail {
  run: Run;
  steps: Step[];
  approvals: Approval[];
  egress: EgressEvent[];
  /** Values are stripped — the client only ever sees placeholders and classes. */
  piiSpans: PiiSpan[];
  scheduleDecisions: ScheduleDecision[];
  agentSessions: AgentSessionState[];
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

  const at = nowIso();
  const parsedObject =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  const graphId = typeof parsedObject?.graphId === 'string' ? parsedObject.graphId : undefined;
  const run: Run = {
    id: newId('run'),
    kind: args.kind,
    title: args.title ?? (args.kind === 'graph' ? playbookTitleFor(input) : playbook.title),
    status: 'pending',
    input,
    ...(graphId ? { graphId } : {}),
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

export async function getRunEvents(id: string, since = 0): Promise<StoredEvent[] | null> {
  if (!(await store.getRun(id))) return null;
  return store.eventsSince(id, Math.max(0, since));
}

export async function getRunDetail(id: string): Promise<RunDetail | null> {
  const run = await store.getRun(id);
  if (!run) return null;

  const [steps, approvals, egress, piiWithValues, scheduleDecisions, agentSessions] =
    await Promise.all([
      store.listSteps(id),
      store.listApprovals(id),
      store.listEgress(id),
      store.listPiiSpans(id),
      store.listScheduleDecisions(id),
      store.listSessionStates(id),
    ]);

  return {
    run,
    steps,
    approvals,
    egress,
    piiSpans: piiWithValues.map(stripPiiValue),
    scheduleDecisions,
    agentSessions,
  };
}

/**
 * Pause and resume.
 *
 * Both are no-ops on a run that is not executing in THIS process: a pause latch
 * only means something to the loop that checks it, so pretending a restarted
 * run can be paused would be a lie the UI would then render as truth.
 */
export async function pauseRun(id: string): Promise<Run | null> {
  const run = await store.getRun(id);
  if (!run) return null;

  if (isTerminal(run.status)) {
    throw new ValidationError('Run ' + id + ' is already ' + run.status, { status: run.status });
  }
  if (!orchestrator.isRunning(id)) {
    throw new ValidationError(
      'Run ' + id + ' is not executing in this process and cannot be paused',
      { status: run.status },
    );
  }

  // The status flips to 'paused' when the run actually reaches a checkpoint,
  // not here -- reporting it earlier would claim a step had stopped while it
  // was still running.
  gatePauseRun(id);
  return run;
}

export async function resumeRun(id: string): Promise<Run | null> {
  const run = await store.getRun(id);
  if (!run) return null;

  if (!gateResumeRun(id)) {
    throw new ValidationError('Run ' + id + ' is not paused', { status: run.status });
  }
  return run;
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
