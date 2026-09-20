/**
 * `authorize_action` — the STOPGAP, clearly marked.
 *
 * ============================================================================
 * THIS IS NOT 3B's TO OWN. Person 2 owns `authorize_action`, risk rules,
 * privacy labels and approval enforcement. There is no TypeScript
 * implementation yet, so this file is a thin wrapper over what already exists
 * (`core/risk.ts`'s synchronous `classify()` and `core/approvalGate.ts`'s
 * `waitForApproval`) so 3B's executor has something real to call. When Person 2
 * ships the real gate, DELETE this file and bind `AuthorizeAction` to theirs —
 * the executor never changes, because it only ever knew the protocol.
 *
 * NO RISK LOGIC LIVES IN THE EXECUTOR. It lives here, and here it is a
 * deliberately literal reading of the existing policy.
 *
 * THE FOUR FAIL-CLOSED PATHS are enforced in `guardAuthorization` below, not in
 * this implementation, so they hold for Person 2's version too:
 *   explicit deny · thrown error · timeout · missing/malformed response
 * All four block. There is no default-allow anywhere in this file.
 * ============================================================================
 */

import type { AuthorizeAction, ProposedAction, ToolAction, ToolAuthorization } from '@htn/shared';
import { classify } from '../risk.js';

/** How long Person 2's gate gets to answer before we block. */
export const AUTHORIZE_TIMEOUT_MS = 10_000;

/**
 * The approval half, injected. 3B does not own approvals: Person 1 owns
 * pause/resume and the endpoints, so the executor is handed a function that
 * creates an Approval and blocks, rather than reaching into the store itself.
 *
 * Returning `revisedArguments` is how a human-edited payload gets back — and
 * the executor runs THOSE, never the payload the human edited away.
 */
export type RequestApproval = (
  action: ToolAction,
  reason: string,
  signal?: AbortSignal,
) => Promise<{ approved: boolean; revisedArguments?: Record<string, never> | ToolAction['args'] }>;

export interface StopgapOptions {
  /**
   * Called when the classifier says `ask_human`. If omitted, an `ask_human`
   * action is DENIED rather than auto-run: no approver means no approval.
   */
  requestApproval?: RequestApproval;
  /** Maps a tool id onto the verb `core/risk.ts` classifies. */
  actionKind?: (action: ToolAction) => string;
}

/**
 * `browser.submit` -> `submit_form`, so the existing rules fire correctly.
 * Exported so the approval bridge (services/runtime.ts) labels an approval with
 * the SAME kind the gate classified -- two spellings would let them disagree.
 */
export function defaultActionKind(action: ToolAction): string {
  const operation = action.toolId.split('.').slice(1).join('.');
  switch (operation) {
    case 'submit':
      return 'submit_form';
    case 'type':
    case 'click':
      // A click or a keystroke is reversible on its own. What makes an outcome
      // irreversible is the SUBMIT, which is classified separately above.
      return 'interact';
    default:
      return 'read_page';
  }
}

/**
 * Build the stopgap gate.
 *
 * `destination` and `providerId` come out of THIS function, not out of config,
 * because the executor must not choose its own backend. The rule encoded here
 * is the design spec's: local-only context and secret data may go to the local
 * browser and nowhere else.
 */
export function createStopgapAuthorizeAction(options: StopgapOptions = {}): AuthorizeAction {
  const actionKind = options.actionKind ?? defaultActionKind;

  return async (action: ToolAction, signal?: AbortSignal): Promise<ToolAuthorization> => {
    /* -- 1. Destination policy (seam 3). --------------------------------- */
    const isLocalOnly = action.contextScope === 'local_only';
    const hasSecret = action.dataLabels.includes('secret');
    const mustStayLocal = isLocalOnly || hasSecret;

    // The proposal names a destination; policy decides whether it stands.
    const wantsRemote =
      action.destination.startsWith('http://') || action.destination.startsWith('https://');

    if (mustStayLocal && wantsRemote) {
      return {
        outcome: 'deny',
        reason: isLocalOnly
          ? 'local-only-context-may-not-leave-the-machine'
          : 'secret-data-may-not-leave-the-machine',
        riskClass: 'ask_human',
      };
    }

    const proposed: ProposedAction = {
      kind: actionKind(action),
      description: action.toolId + ' on ' + action.destination,
      payload: action.args,
    };

    const decision = classify(proposed);

    /* -- 2. Risk. --------------------------------------------------------- */
    if (decision.riskClass === 'ask_human') {
      if (!options.requestApproval) {
        // Fail closed. "No approver configured" is not a reason to proceed.
        return {
          outcome: 'deny',
          reason: 'approval-required-but-no-approver-configured',
          riskClass: 'ask_human',
        };
      }

      const outcome = await options.requestApproval(action, decision.rule, signal);
      if (!outcome.approved) {
        return { outcome: 'deny', reason: 'rejected-by-human', riskClass: 'ask_human' };
      }

      return {
        outcome: 'allow',
        reason: decision.rule,
        riskClass: 'ask_human',
        ...(mustStayLocal ? { providerId: 'localbrowser' as const } : {}),
        // A human may have edited the payload. If so, THAT is what runs.
        ...(outcome.revisedArguments ? { revisedArguments: outcome.revisedArguments } : {}),
      };
    }

    return {
      outcome: 'allow',
      reason: decision.rule,
      riskClass: decision.riskClass,
      ...(mustStayLocal ? { providerId: 'localbrowser' as const } : {}),
    };
  };
}

/* -------------------------------------------------------------------------- */
/* The four fail-closed paths                                                 */
/* -------------------------------------------------------------------------- */

export interface GuardedAuthorization {
  authorization: ToolAuthorization;
  /** Which of the four paths produced a block, when one did. */
  failure?: 'denied' | 'threw' | 'timeout' | 'missing_response';
}

function blocked(
  failure: NonNullable<GuardedAuthorization['failure']>,
  reason: string,
): GuardedAuthorization {
  return {
    authorization: { outcome: 'deny', reason, riskClass: 'ask_human' },
    failure,
  };
}

/**
 * Wrap ANY `AuthorizeAction` — the stopgap or Person 2's real one — so that all
 * four failure modes block identically.
 *
 * This exists because the dangerous case is not "the gate said no". It is the
 * gate throwing, hanging, or returning `undefined`, each of which a naive
 * caller treats as "no objection raised" and proceeds. Schema hiding is an
 * optimisation, not authorization; this is authorization.
 */
export async function guardAuthorization(
  authorize: AuthorizeAction,
  action: ToolAction,
  signal?: AbortSignal,
  timeoutMs: number = AUTHORIZE_TIMEOUT_MS,
): Promise<GuardedAuthorization> {
  let timer: NodeJS.Timeout | undefined;

  try {
    const timeout = new Promise<'__timeout__'>((resolve) => {
      timer = setTimeout(() => resolve('__timeout__'), timeoutMs);
    });

    const raced = await Promise.race([authorize(action, signal), timeout]);

    // PATH 3 — timeout.
    if (raced === '__timeout__') {
      return blocked('timeout', 'authorization-timed-out-after-' + timeoutMs + 'ms');
    }

    // PATH 4 — missing or malformed response. `undefined`, `null`, or an object
    // without a recognisable outcome all block. An unrecognised outcome value
    // is NOT treated as allow.
    const result = raced as ToolAuthorization | undefined | null;
    if (!result || typeof result !== 'object' || typeof result.outcome !== 'string') {
      return blocked('missing_response', 'authorization-returned-no-decision');
    }
    if (result.outcome !== 'allow' && result.outcome !== 'deny') {
      return blocked('missing_response', 'authorization-returned-unknown-outcome');
    }

    // PATH 1 — explicit deny.
    if (result.outcome === 'deny') {
      return { authorization: result, failure: 'denied' };
    }

    return { authorization: result };
  } catch (err) {
    // PATH 2 — thrown error.
    return blocked(
      'threw',
      'authorization-threw: ' + (err instanceof Error ? err.message : String(err)),
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
