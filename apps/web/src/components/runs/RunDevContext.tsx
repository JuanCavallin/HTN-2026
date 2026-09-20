/**
 * Per-run detail data, made available to any step row without prop-threading.
 *
 * StepRow sits two levels below RunDetail (and three below it inside a
 * SwarmGrid), and the dev panel needs run-scoped collections -- the egress
 * ledger, the routing decisions, the log -- that the step itself does not
 * carry. Threading four more props through StepTimeline and SwarmGrid purely
 * so a collapsed panel can read them would put run-level plumbing into two
 * components that have no other use for it.
 *
 * Nothing here fetches. Every field comes straight from useRunStream, so the
 * dev panel updates live with the rest of the page and shows exactly what the
 * server actually emitted -- never a second, separately-fetched version of the
 * truth that could disagree with the timeline above it.
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { EgressEvent, ScheduleDecision } from '@htn/shared';

export interface RunLogEntry {
  level: string;
  message: string;
  at: string;
}

export interface RunDevValue {
  egress: EgressEvent[];
  scheduleDecisions: ScheduleDecision[];
  logs: RunLogEntry[];
  /** When true, every step row starts expanded. Individual rows still toggle. */
  devMode: boolean;
}

const EMPTY: RunDevValue = { egress: [], scheduleDecisions: [], logs: [], devMode: false };

const RunDevContext = createContext<RunDevValue>(EMPTY);

export function RunDevProvider({ value, children }: { value: RunDevValue; children: ReactNode }) {
  return <RunDevContext.Provider value={value}>{children}</RunDevContext.Provider>;
}

/**
 * Safe outside a provider: returns empty collections rather than throwing, so
 * a StepRow rendered somewhere else (a future embed, a test) still works and
 * simply has nothing extra to show.
 */
export function useRunDev(): RunDevValue {
  return useContext(RunDevContext);
}
