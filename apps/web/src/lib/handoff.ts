/**
 * Matching a pending handoff approval to the browser session it is waiting on.
 *
 * ONE implementation, because two run surfaces need the same answer and a
 * second copy would drift: the redesigned `LiveRunWorkspace` renders approvals
 * in its conversation lane, and `RunDetail` renders them above the canvas.
 *
 * The join key is `sessionId`, which `runHandoff` (core/graph/interpreter.ts)
 * puts in the approval's payload precisely so the UI can do this. The session's
 * URL arrives separately, on the run stream as `browser.session.opened` -- see
 * BrowserSessionRecord for why it is announced rather than carried on a step.
 */

import type { Approval, BrowserSessionRecord, Iso } from '@htn/shared';

type SessionLike = BrowserSessionRecord & { closedAt?: Iso };

/** The payload shape runHandoff writes. Everything optional -- this is wire data. */
interface HandoffPayload {
  kind?: unknown;
  sessionId?: unknown;
}

function payloadOf(approval: Approval): HandoffPayload | null {
  const action = approval.proposedAction;
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  return action as HandoffPayload;
}

/** True when this approval is a handoff rather than an ordinary risk gate. */
export function isHandoffApproval(approval: Approval): boolean {
  return payloadOf(approval)?.kind === 'human_handoff';
}

/**
 * The interactive browser URL for a handoff approval, or undefined.
 *
 * Undefined is a NORMAL outcome, not a failure: local and mocked browsers have
 * no viewable session, and Browserbase's debug URL is gone once the session
 * stops. Callers must render something sensible for it rather than a dead link.
 *
 * A CLOSED session returns undefined too. The URL 410s from the moment the
 * session ends, so offering it would hand someone a link to an error page.
 */
export function liveViewUrlFor(
  approval: Approval,
  sessions: readonly SessionLike[],
): string | undefined {
  const sessionId = payloadOf(approval)?.sessionId;
  if (typeof sessionId !== 'string') return undefined;

  const session = sessions.find((candidate) => candidate.sessionId === sessionId);
  if (!session || session.closedAt) return undefined;
  return session.liveViewUrl;
}
