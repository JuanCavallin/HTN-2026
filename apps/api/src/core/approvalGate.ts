/**
 * The blocking half of the risk gate.
 *
 * The orchestrator awaits a promise; POST /api/approvals/:id/decide resolves it.
 * Waiters live in memory only — that is correct, because a pending approval is
 * meaningless once the process that was waiting on it is gone. On restart the
 * approval is marked 'expired' rather than silently resuming.
 */

export type ApprovalOutcome = 'approved' | 'rejected';

export class ApprovalRejectedError extends Error {
  readonly code = 'APPROVAL_REJECTED';
  constructor(
    readonly approvalId: string,
    readonly note?: string,
  ) {
    super('Approval ' + approvalId + ' was rejected' + (note ? ': ' + note : ''));
    this.name = 'ApprovalRejectedError';
  }
}

interface Waiter {
  resolve: (outcome: ApprovalOutcome) => void;
  reject: (err: Error) => void;
}

const waiters = new Map<string, Waiter>();

/** Block until someone decides this approval, or the run is aborted. */
export function waitForApproval(
  approvalId: string,
  signal?: AbortSignal,
): Promise<ApprovalOutcome> {
  return new Promise<ApprovalOutcome>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Run aborted before approval'));
      return;
    }

    waiters.set(approvalId, { resolve, reject });

    signal?.addEventListener(
      'abort',
      () => {
        waiters.delete(approvalId);
        reject(new Error('Run aborted while awaiting approval'));
      },
      { once: true },
    );
  });
}

/**
 * Resolve a waiting orchestrator.
 * Returns false when nobody is waiting — a stale decision after a restart, which
 * the caller should surface rather than swallow.
 */
export function settleApproval(approvalId: string, outcome: ApprovalOutcome): boolean {
  const waiter = waiters.get(approvalId);
  if (!waiter) return false;
  waiters.delete(approvalId);
  waiter.resolve(outcome);
  return true;
}

export function isAwaiting(approvalId: string): boolean {
  return waiters.has(approvalId);
}

export function pendingCount(): number {
  return waiters.size;
}
