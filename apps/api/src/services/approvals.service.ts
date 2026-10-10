/**
 * Approval decisions — the client->server half of the risk gate.
 *
 * Deliberately a plain POST rather than a WebSocket message: it gets zod
 * validation, HTTP status codes, and idempotency through the same middleware as
 * every other route.
 */

import type { Approval, ApprovalDecision, Json } from '@htn/shared';
import { pendingAction, settleApproval } from '../core/approvalGate.js';
import { reauthorizeRevision } from '../core/risk.js';
import { nowIso } from '../lib/ids.js';
import { bus, store } from './runtime.js';

/** The client sent a revision the gate refuses. Distinct from a conflict. */
export class ApprovalRevisionError extends Error {
  readonly code = 'APPROVAL_REVISION_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRevisionError';
  }
}

function toJson(value: unknown): Json {
  return (JSON.parse(JSON.stringify(value ?? null)) ?? null) as Json;
}

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
export async function decideApproval(id: string, body: ApprovalDecision): Promise<Approval> {
  const { decision, note } = body;
  const existing = await store.getApproval(id);
  if (!existing) throw new ApprovalConflictError('Approval ' + id + ' not found');

  if (existing.status !== 'pending') {
    throw new ApprovalConflictError(
      'Approval ' + id + ' is already ' + existing.status + ' and cannot be changed',
    );
  }

  // A revision is reauthorized BEFORE anything is persisted or released, so a
  // refused revision leaves the approval exactly as it was: still pending, still
  // decidable. Nothing half-applied.
  let patch: Partial<Approval> = { status: decision, decidedAt: nowIso(), note };
  let outcomeAction = pendingAction(id);

  if (decision === 'revised') {
    const original = pendingAction(id);
    if (!original) {
      throw new ApprovalConflictError(
        'Approval ' + id + ' can no longer be revised — nothing is waiting on it',
      );
    }

    const authorization = reauthorizeRevision(original, {
      payload: body.revisedPayload,
      amountCents: body.revisedAmountCents,
    });
    if (!authorization.ok) throw new ApprovalRevisionError(authorization.reason);

    outcomeAction = authorization.action;
    patch = {
      ...patch,
      // Both survive: what was asked for, and what actually runs.
      revisedAction: toJson(authorization.action.payload),
      reversibility: authorization.decision.reversibility,
      riskClass: authorization.decision.riskClass,
      reauthorizedRule: authorization.decision.rule,
    };
  }

  const updated = await store.patchApproval(id, patch);

  await bus.emit(updated.runId, { type: 'approval.resolved', approval: updated });

  const released =
    outcomeAction !== null && settleApproval(id, { verdict: decision, action: outcomeAction });
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
