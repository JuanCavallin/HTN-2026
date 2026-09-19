/**
 * The single client-side reducer. Every component on the run page reads from this.
 *
 * Note what is NOT here: there is no initial fetch. The SSE endpoint replays the
 * run's whole event history on connect (cursor 0), so the stream alone rebuilds
 * complete state. On reconnect the browser sends Last-Event-ID automatically and
 * the server replays only the gap. Reloading mid-run is therefore lossless and
 * needs no extra code.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { emptyRunView, isTerminal, type RunEvent, type RunView } from '@htn/shared';

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id);
  if (index === -1) return [...list, item];
  const next = [...list];
  next[index] = item;
  return next;
}

export function runReducer(state: RunView, event: RunEvent): RunView {
  switch (event.type) {
    case 'run.updated':
      return { ...state, run: event.run };

    case 'step.upserted':
      return { ...state, steps: upsert(state.steps, event.step).sort((a, b) => a.seq - b.seq) };

    case 'approval.requested':
    case 'approval.resolved':
      return { ...state, approvals: upsert(state.approvals, event.approval) };

    case 'egress.logged':
      return { ...state, egress: [...state.egress, event.egress] };

    case 'pii.detected':
      return { ...state, piiSpans: upsert(state.piiSpans, event.span) };

    case 'log':
      return {
        ...state,
        logs: [...state.logs, { level: event.level, message: event.message, at: event.at }],
      };

    default:
      // An older tab must not break when the server learns a new event type.
      return state;
  }
}

export interface RunStreamState extends RunView {
  connected: boolean;
}

export function useRunStream(runId: string | undefined): RunStreamState {
  const [view, dispatch] = useReducer(runReducer, emptyRunView);
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!runId) return;

    const source = new EventSource('/api/runs/' + runId + '/stream');
    sourceRef.current = source;

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      try {
        dispatch(JSON.parse(message.data) as RunEvent);
      } catch {
        // A malformed frame must not tear down the stream.
      }
    };

    return () => {
      source.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [runId]);

  // Close the stream once the run can produce no more events. Leaving it open
  // would hold one of the browser's ~6 connections per origin for nothing.
  useEffect(() => {
    if (view.run && isTerminal(view.run.status) && sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
      setConnected(false);
    }
  }, [view.run]);

  return { ...view, connected };
}
