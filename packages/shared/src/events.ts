/**
 * The SSE wire format AND the frontend reducer's input. One union, one reducer.
 *
 * Adding a new event type is safe: the client reducer's `default` case ignores
 * anything it doesn't recognise, so an older tab never breaks on a newer server.
 */

import type { Approval, EgressEvent, Iso, PiiSpan, Run, Step } from './domain.js';

export type RunEvent =
  | { type: 'run.updated'; run: Run }
  | { type: 'step.upserted'; step: Step }
  | { type: 'approval.requested'; approval: Approval }
  | { type: 'approval.resolved'; approval: Approval }
  | { type: 'egress.logged'; egress: EgressEvent }
  | { type: 'pii.detected'; span: PiiSpan }
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; message: string; at: Iso };

export type RunEventType = RunEvent['type'];

/** An event as persisted. `seq` is monotonic per run and powers SSE replay. */
export interface StoredEvent {
  seq: number;
  runId: string;
  event: RunEvent;
  at: Iso;
}

/**
 * Everything the RunDetail page renders, rebuilt from the event stream alone.
 * The reducer that produces this lives in apps/web/src/hooks/useRunStream.ts.
 */
export interface RunView {
  run: Run | null;
  steps: Step[];
  approvals: Approval[];
  egress: EgressEvent[];
  piiSpans: PiiSpan[];
  logs: { level: 'info' | 'warn' | 'error'; message: string; at: Iso }[];
  /** Highest `seq` applied. Used as the replay cursor on reconnect. */
  lastSeq: number;
}

export const emptyRunView: RunView = {
  run: null,
  steps: [],
  approvals: [],
  egress: [],
  piiSpans: [],
  logs: [],
  lastSeq: 0,
};
