/**
 * Approval decisions — the client->server half of the risk gate.
 *
 * Deliberately a plain POST rather than a WebSocket message: it gets zod
 * validation, HTTP status codes, and idempotency through the same middleware as
 * every other route.
 */

import type { Approval } from '@htn/shared';
import { settleApproval } from '../core/approvalGate.js';
import { nowIso } from '../lib/ids.js';
import { bus, store } from './runtime.js';

export class ApprovalConflictError extends Error {
  readonly code = 'APPROVAL_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalConflictError';
  }
}

export async function listPendingApprovals(runId: string): Promise<Approval[]> {
  const all = await store.listApprovals(runId);
  return all.filter((a) => a.status === 'pending');
}

export async function getApproval(id: string): Promise<Approval | null> {
  return store.getApproval(id);
}

/**
 * Record the decision, tell the UI, then release the blocked orchestrator.
 *
 * Order matters: persist and emit BEFORE settling, so that by the time the run
 * resumes, any client watching has already seen the resolution.
 */
export async function decideApproval(
  id: string,
  decision: 'approved' | 'rejected',
  note?: string,
): Promise<Approval> {
  const existing = await store.getApproval(id);
  if (!existing) throw new ApprovalConflictError('Approval ' + id + ' not found');

  if (existing.status !== 'pending') {
    throw new ApprovalConflictError(
      'Approval ' + id + ' is already ' + existing.status + ' and cannot be changed',
    );
  }

  const updated = await store.patchApproval(id, {
    status: decision,
    decidedAt: nowIso(),
    note,
  });

  await bus.emit(updated.runId, { type: 'approval.resolved', approval: updated });

  const released = settleApproval(id, decision);
  if (!released) {
    // Nobody was waiting — the process restarted while this approval was pending.
    // Surface it instead of leaving a run stuck in awaiting_approval forever.
    const run = await store.patchRun(updated.runId, {
      status: 'failed',
      summary: 'The run was no longer waiting on this approval (server restarted).',
      error: {
        code: 'APPROVAL_ORPHANED',
        message: 'No orchestrator was awaiting approval ' + id,
      },
    });
    await bus.emit(run.id, { type: 'run.updated', run });
  }

  return updated;
}
