/**
 * The SSE wire format AND the frontend reducer's input. One union, one reducer.
 *
 * Adding a new event type is safe: the client reducer's `default` case ignores
 * anything it doesn't recognise, so an older tab never breaks on a newer server.
 */

import type { BrowserSessionRecord } from './browser.js';
import type { Approval, EgressEvent, Iso, PiiSpan, Run, Step } from './domain.js';
import type {
  AgentSessionState,
  ControlDecisionRecord,
  HarnessTurnEvent,
  ModelLifecycleEvent,
  ToolLifecycleEvent,
} from './control.js';
import type { ScheduleDecision } from './scheduling.js';

export type RunEvent =
  | { type: 'run.updated'; run: Run }
  | { type: 'step.upserted'; step: Step }
  | { type: 'approval.requested'; approval: Approval }
  | { type: 'approval.resolved'; approval: Approval }
  | { type: 'egress.logged'; egress: EgressEvent }
  | { type: 'pii.detected'; span: PiiSpan }
  | { type: 'schedule.decided'; decision: ScheduleDecision }
  /**
   * A browser session became watchable. Announced on the stream rather than
   * carried on a step because the opening node is often not the node you want
   * to watch — see BrowserSessionRecord for the full reasoning.
   */
  | { type: 'browser.session.opened'; session: BrowserSessionRecord }
  /**
   * The session was released. The UI must stop showing its live view as live:
   * Browserbase's debug URL returns 410 Gone from this moment, so a viewer
   * left pointed at it renders an error rather than a page.
   */
  | { type: 'browser.session.closed'; runId: string; sessionId: string; at: Iso }
  | { type: 'control.decided'; decision: ControlDecisionRecord }
  | { type: 'model.lifecycle'; lifecycle: ModelLifecycleEvent }
  | { type: 'harness.turn'; turn: HarnessTurnEvent }
  | { type: 'tool.lifecycle'; lifecycle: ToolLifecycleEvent }
  | { type: 'session.updated'; session: AgentSessionState }
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
  scheduleDecisions: ScheduleDecision[];
  /**
   * Browser sessions this run opened, newest last. `closedAt` is set in place
   * when the matching close event arrives, so a finished run still lists every
   * session it used — the panel needs that to show a decision replay.
   */
  browserSessions: (BrowserSessionRecord & { closedAt?: Iso })[];
  controlDecisions: ControlDecisionRecord[];
  modelCalls: ModelLifecycleEvent[];
  harnessTurns: HarnessTurnEvent[];
  /**
   * Every `tool.lifecycle` event, in arrival order. One tool action produces several
   * (proposed -> policy_decided -> ... -> succeeded), all sharing `action.id`; group by it.
   */
  toolLifecycle: ToolLifecycleEvent[];
  agentSessions: AgentSessionState[];
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
  scheduleDecisions: [],
  browserSessions: [],
  controlDecisions: [],
  modelCalls: [],
  harnessTurns: [],
  toolLifecycle: [],
  agentSessions: [],
  logs: [],
  lastSeq: 0,
};
