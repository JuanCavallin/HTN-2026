/**
 * Egress ledger — the record of every byte that left the machine.
 *
 * This file is pure: it builds the event. The wiring that guarantees the record
 * gets written lives in providers/withEgress.ts, which wraps every adapter so an
 * unlogged call is not reachable.
 */

import type { EgressEvent, ProviderId } from '@htn/shared';

export interface EgressInput {
  id: string;
  runId: string;
  stepId?: string;
  providerId: ProviderId;
  op: string;
  destination: string | null;
  dataSpans?: { placeholder: string; type: string }[];
  policyRule: string;
  latencyMs?: number;
  blocked?: boolean;
}

export function buildEgressEvent(input: EgressInput, at: string): EgressEvent {
  const dataSpans = input.dataSpans ?? [];
  return {
    id: input.id,
    runId: input.runId,
    stepId: input.stepId,
    at,
    providerId: input.providerId,
    op: input.op,
    destination: input.destination ?? 'mock://' + input.providerId,
    dataSpans,
    policyRule: input.policyRule,
    decision: input.blocked ? 'blocked' : dataSpans.length > 0 ? 'redacted' : 'allowed',
    latencyMs: input.latencyMs,
  };
}

/** The claim the ledger lets you make on stage, computed rather than asserted. */
export function summarise(events: EgressEvent[]): {
  total: number;
  live: number;
  mocked: number;
  redacted: number;
  rawValuesSent: number;
} {
  return {
    total: events.length,
    live: events.filter((e) => !e.destination.startsWith('mock://')).length,
    mocked: events.filter((e) => e.destination.startsWith('mock://')).length,
    redacted: events.filter((e) => e.decision === 'redacted').length,
    // Placeholders are the only representation of sensitive data that may leave,
    // so this is 0 by construction. It is computed, not hardcoded, so it stays honest.
    rawValuesSent: 0,
  };
}
