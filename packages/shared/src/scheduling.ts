/**
 * Scheduling — Jev's routing decisions: which model tier and which tools it
 * exposed for a subtask, and why.
 *
 * Deliberately a separate file from policy.ts: policy.ts governs WHETHER an
 * action needs a human (reversibility); this governs HOW a subtask gets
 * executed (which model, which tools). Different questions, same
 * "decision + rule string" shape so they read the same way in the UI.
 */

import type { Iso } from './domain.js';
import type { Capability, ModelTier, ProviderId } from './providers.js';

/**
 * One routing decision, recorded BEFORE a subtask runs and never mutated
 * afterward — unlike Approval/EgressEvent, this is a snapshot of a choice, not
 * a thing with a lifecycle. Outcome data (tokens actually used, tools actually
 * called) is recorded on the Step's output and the egress ledger instead,
 * exactly like every other provider call — this entity only answers "what was
 * decided, and why."
 */
export interface ScheduleDecision {
  id: string;
  runId: string;
  stepId: string;
  /** Which capability was being routed — almost always 'agent.runtime' today. */
  requestedCapability: Capability;
  /** The provider bound to that capability at decision time. */
  selectedProvider: ProviderId;
  modelTier: ModelTier;
  /** The full candidate list Jev was given, before filtering. */
  availableTools: string[];
  /** What Jev actually let through. availableTools.length vs this is the M2 headline number. */
  exposedTools: string[];
  confidence: number;
  escalated: boolean;
  escalationReason?: string;
  /** Which rule produced this decision — same pattern as RiskDecision.rule. */
  rule: string;
  at: Iso;
}
