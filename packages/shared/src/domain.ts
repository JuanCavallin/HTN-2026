/**
 * Core domain entities.
 *
 * These describe SUPERVISED AGENTIC WORK, deliberately not any subject matter.
 * There is no TuitionStatement, no InsuranceClaim, no Listing anywhere in here —
 * all product specificity lives in `Run.kind`, the Json blobs, and one playbook file.
 *
 * Rule for edits: ADDITIVE ONLY, and new fields are optional. That keeps old
 * fixtures and old code compiling at 3am.
 */

import type { PiiType, Reversibility, RiskClass } from './policy.js';
import type { ProviderId } from './providers.js';

/** ISO-8601 timestamp. */
export type Iso = string;

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

export type RunStatus =
  'pending' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'cancelled';

/** A terminal status means no further events will arrive for this run. */
export const TERMINAL_RUN_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

export function isTerminal(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export interface Run {
  id: string;
  /** Playbook id. THE pivot knob — the only product-specific thing at this level. */
  kind: string;
  title: string;
  status: RunStatus;
  /** Shape is validated per-kind by a zod schema in `schemas/playbooks`. */
  input: Json;
  /** One-line human result, rendered on the run card. */
  summary?: string;
  /** Per-kind payload. The UI picks a result renderer by `kind`. */
  result?: Json;
  error?: { code: string; message: string };
  createdAt: Iso;
  updatedAt: Iso;
}

/* -------------------------------------------------------------------------- */
/* Step                                                                       */
/* -------------------------------------------------------------------------- */

export type StepStatus = 'pending' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'skipped';

export interface Step {
  id: string;
  runId: string;
  /**
   * Swarm fan-out tree, for free. A fan-out is N steps sharing a parent; the judge
   * is a sibling step whose input references them. No separate entity needed, and
   * nothing changes if the swarm becomes recursive or collapses to a pipeline.
   */
  parentStepId: string | null;
  /** Monotonic within a run. Drives timeline ordering. */
  seq: number;
  /** 'fetch' | 'worker' | 'judge' | 'browse' | 'decide' | ... */
  kind: string;
  /** Human string shown in the timeline. */
  label: string;
  status: StepStatus;
  /** Which adapter did the work. Rendered as a badge. */
  providerId?: ProviderId;
  riskClass?: RiskClass;
  approvalId?: string;
  input?: Json;
  output?: Json;
  error?: { code: string; message: string };
  startedAt?: Iso;
  endedAt?: Iso;
}

/* -------------------------------------------------------------------------- */
/* Approval                                                                   */
/* -------------------------------------------------------------------------- */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface Approval {
  id: string;
  runId: string;
  stepId: string;
  /** e.g. "Submit the fee-adjustment request to the Registrar?" */
  question: string;
  /** Exactly what will be sent if approved. Shown verbatim — no summarising. */
  proposedAction: Json;
  reversibility: Reversibility;
  riskClass: RiskClass;
  /** Which rule demanded a human. */
  policyRule: string;
  status: ApprovalStatus;
  decidedAt?: Iso;
  note?: string;
  createdAt: Iso;
}

/* -------------------------------------------------------------------------- */
/* Egress ledger                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One outbound call. Records WHAT CLASS of data left and WHY it was allowed —
 * never the value. Works identically whether the payload was a tuition PDF or
 * an insurance claim.
 */
export interface EgressEvent {
  id: string;
  runId: string;
  stepId?: string;
  at: Iso;
  providerId: ProviderId;
  op: string;
  /** Host contacted, or `mock://<provider>`. */
  destination: string;
  dataSpans: { placeholder: string; type: string }[];
  policyRule: string;
  decision: 'allowed' | 'redacted' | 'blocked';
  latencyMs?: number;
}

/* -------------------------------------------------------------------------- */
/* PII                                                                        */
/* -------------------------------------------------------------------------- */

export interface PiiSpan {
  id: string;
  runId: string;
  type: PiiType;
  /** What a cloud model actually sees, e.g. "[[PII_3]]". */
  placeholder: string;
  /** Provenance: which document or field it came from. */
  field: string;
  routedTo: 'local' | 'cloud';
}

/**
 * Server-side only. The `value` never crosses the wire — `PiiSpan` is the client
 * shape, this one stays in the store.
 */
export interface PiiSpanWithValue extends PiiSpan {
  value: string;
}

export function stripPiiValue(span: PiiSpanWithValue): PiiSpan {
  const { value: _value, ...rest } = span;
  return rest;
}
