/**
 * The PlaybookContext of every run currently executing in this process.
 *
 * WHY THIS EXISTS: the tool plane is a process-wide singleton (its registry,
 * resolution cache and executors are built once), but an approval is a
 * per-RUN thing -- it has to create an Approval row on the right run, block
 * that run's promise, and resume it. Executors only receive a `ToolAction`
 * (runId + stepId), so the approval bridge needs a way back to the run's own
 * context. This is that lookup, and nothing else.
 *
 * Written by the orchestrator when a run starts, deleted when it ends. Absent
 * means "no live run to ask" and every caller must treat that as a DENY.
 */

import type { PlaybookContext } from './playbooks/types.js';

const active = new Map<string, PlaybookContext>();

export function registerRunContext(runId: string, ctx: PlaybookContext): void {
  active.set(runId, ctx);
}

export function runContextFor(runId: string): PlaybookContext | undefined {
  return active.get(runId);
}

export function releaseRunContext(runId: string): void {
  active.delete(runId);
}
