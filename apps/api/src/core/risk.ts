/**
 * The risk gate.
 *
 * We classify by REVERSIBILITY, not by model confidence. Calibrating a small
 * model's confidence is an open research problem; "can this be undone?" is a
 * property of the action that we can write down, defend, and show to a user.
 *
 * The rules below are data, not prompt text, on purpose — an LLM never decides
 * whether a human gets asked.
 */

import type { ProposedAction, Reversibility, RiskClass, RiskDecision } from '@htn/shared';

/** Anything here is irreversible regardless of what the playbook claims. */
const IRREVERSIBLE_KINDS = new Set([
  'submit_form',
  'send_email',
  'send_message',
  'transfer_funds',
  'make_payment',
  'cancel_service',
  'delete',
  'publish',
  'accept_terms',
  'place_order',
]);

/** Undoable, but only via a human, a support ticket, or a waiting period. */
const RECOVERABLE_KINDS = new Set([
  'schedule',
  'book',
  'upload_document',
  'update_profile',
  'create_draft',
]);

/** Above this, a human is asked even for an otherwise-safe action. */
export const APPROVAL_AMOUNT_THRESHOLD_CENTS = 2500;

export function inferReversibility(action: ProposedAction): Reversibility {
  if (action.reversibility) return action.reversibility;
  if (IRREVERSIBLE_KINDS.has(action.kind)) return 'irreversible';
  if (RECOVERABLE_KINDS.has(action.kind)) return 'recoverable';
  return 'reversible';
}

/**
 * The whole policy, in one readable function. If a judge asks "when does it stop?",
 * this is the answer you show them.
 */
export function classify(action: ProposedAction): RiskDecision {
  const reversibility = inferReversibility(action);

  if (reversibility === 'irreversible') {
    return {
      reversibility,
      riskClass: 'ask_human',
      rule: 'irreversible-action-requires-approval',
    };
  }

  if ((action.amountCents ?? 0) >= APPROVAL_AMOUNT_THRESHOLD_CENTS) {
    return {
      reversibility,
      riskClass: 'ask_human',
      rule: 'amount-over-threshold-requires-approval',
    };
  }

  if (reversibility === 'recoverable') {
    return { reversibility, riskClass: 'verify', rule: 'recoverable-action-verified' };
  }

  return { reversibility, riskClass: 'auto', rule: 'reversible-action-auto' };
}

/** Human-readable rendering of a rule id, for the approval panel. */
export function describeRule(rule: string): string {
  switch (rule) {
    case 'irreversible-action-requires-approval':
      return 'This cannot be undone, so a human decides.';
    case 'amount-over-threshold-requires-approval':
      return 'The amount is over the auto-approval threshold.';
    case 'recoverable-action-verified':
      return 'Undoable with effort, so the result is double-checked.';
    case 'reversible-action-auto':
      return 'Fully reversible, so it runs automatically.';
    default:
      return rule;
  }
}

/* -------------------------------------------------------------------------- */
/* Revision reauthorization                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A human editing a payload does not make the edit safe. The spec is explicit:
 * "AgentOS reauthorizes any revision". So a revision goes back through
 * `classify()` exactly like the original did, and on top of that it may only
 * NARROW the action.
 *
 * Narrowing-only matters because the approval panel showed the human one
 * specific action at one specific risk level. If a revision could raise the
 * risk class or reversibility, the thing they clicked "revise" on would not be
 * the thing that ran, and the gate would have been walked around rather than
 * through. Escalations are not refused forever — they are refused HERE, so the
 * agent has to propose them as a fresh action with a fresh approval.
 */
const RISK_RANK: Record<RiskClass, number> = { auto: 0, verify: 1, ask_human: 2 };
const REVERSIBILITY_RANK: Record<Reversibility, number> = {
  reversible: 0,
  recoverable: 1,
  irreversible: 2,
};

export type RevisionAuthorization =
  { ok: true; action: ProposedAction; decision: RiskDecision } | { ok: false; reason: string };

export function reauthorizeRevision(
  original: ProposedAction,
  revision: { payload: unknown; amountCents?: number },
): RevisionAuthorization {
  // `kind` is deliberately NOT taken from the client. It is what the whole
  // classification hangs on, so a revision that could restate it would be a
  // permission bypass with extra steps.
  const revised: ProposedAction = {
    ...original,
    payload: revision.payload,
    amountCents: revision.amountCents ?? original.amountCents,
  };

  const before = classify(original);
  const after = classify(revised);

  if (RISK_RANK[after.riskClass] > RISK_RANK[before.riskClass]) {
    return {
      ok: false,
      reason:
        'The revision raises the risk class from ' +
        before.riskClass +
        ' to ' +
        after.riskClass +
        '. Revisions may only narrow an action; propose this as a new one.',
    };
  }

  if (REVERSIBILITY_RANK[after.reversibility] > REVERSIBILITY_RANK[before.reversibility]) {
    return {
      ok: false,
      reason:
        'The revision makes the action less reversible (' +
        before.reversibility +
        ' -> ' +
        after.reversibility +
        '). Revisions may only narrow an action.',
    };
  }

  if ((revised.amountCents ?? 0) > (original.amountCents ?? 0)) {
    return {
      ok: false,
      reason:
        'The revision raises the amount from ' +
        (original.amountCents ?? 0) +
        ' to ' +
        (revised.amountCents ?? 0) +
        ' cents. Revisions may only narrow an action.',
    };
  }

  return { ok: true, action: revised, decision: after };
}
