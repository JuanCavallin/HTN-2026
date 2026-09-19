/**
 * Run use-cases. The transaction boundary between HTTP and the orchestrator.
 *
 * Key behaviour: createRun persists, emits, and returns IMMEDIATELY. Execution is
 * fire-and-forget; progress reaches the browser over SSE. A route handler must
 * never await a run.
 */

import type { Approval, EgressEvent, Json, PiiSpan, Run, Step } from '@htn/shared';
import { stripPiiValue } from '@htn/shared';
import { getPlaybook, listPlaybooks } from '../core/playbooks/registry.js';
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

  const at = nowIso();
  const run: Run = {
    id: newId('run'),
    kind: args.kind,
    title: args.title ?? playbook.title,
    status: 'pending',
    input: parsed.data as Json,
    createdAt: at,
    updatedAt: at,
  };

  await store.createRun(run);
  await bus.emit(run.id, { type: 'run.updated', run });

  // Fire and forget. Do NOT await.
  orchestrator.start(run);

  return run;
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

  const [steps, approvals, egress, piiWithValues] = await Promise.all([
    store.listSteps(id),
    store.listApprovals(id),
    store.listEgress(id),
    store.listPiiSpans(id),
  ]);

  return { run, steps, approvals, egress, piiSpans: piiWithValues.map(stripPiiValue) };
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
