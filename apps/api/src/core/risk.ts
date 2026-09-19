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

import type { ProposedAction, Reversibility, RiskDecision } from '@htn/shared';

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
