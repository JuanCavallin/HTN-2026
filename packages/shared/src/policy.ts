/**
 * Risk policy vocabulary.
 *
 * The central design decision of this codebase: we do NOT gate actions on model
 * confidence (calibrating that is a research problem). We gate on REVERSIBILITY,
 * which is a property of the action itself and can be written down and defended.
 */

/** Can this action be undone, and at what cost? */
export type Reversibility =
  /** Undoable by us, immediately, with no side effect on anyone else. */
  | 'reversible'
  /** Undoable, but requires a human, a support ticket, or a delay. */
  | 'recoverable'
  /** Cannot be undone. Money moved, a form was submitted, a message was sent. */
  | 'irreversible';

/** What the runtime does when it encounters an action. */
export type RiskClass =
  /** Just run it. */
  | 'auto'
  /** Run it, then have a second pass check the result before continuing. */
  | 'verify'
  /** Stop. Create an Approval and block until a human decides. */
  | 'ask_human';

/** A described action, handed to the classifier. */
export interface ProposedAction {
  /** Short verb phrase: 'submit_form', 'send_email', 'read_page', 'transfer_funds'. */
  kind: string;
  /** Human-readable description shown in the approval panel. */
  description: string;
  /** Monetary impact in cents, if any. Drives the amount threshold. */
  amountCents?: number;
  /** Explicit override when the playbook already knows. */
  reversibility?: Reversibility;
  /** Arbitrary payload that would be sent if approved. Shown verbatim to the user. */
  payload?: unknown;
}

export interface RiskDecision {
  reversibility: Reversibility;
  riskClass: RiskClass;
  /** Which rule fired. Rendered in the UI and recorded in the egress ledger. */
  rule: string;
}

/** Data classes the redactor recognises. Drives local-vs-cloud routing. */
export type PiiType =
  'name' | 'sin' | 'student_id' | 'email' | 'phone' | 'address' | 'account' | 'dob' | 'other';
