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
import { api } from '../lib/api';

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

    // Without this case the field stays empty forever and every tool-reduction
    // number (availableTools vs exposedTools) is invisible to the UI, even
    // though the server emits the event and RunView declares the field.
    case 'schedule.decided':
      return {
        ...state,
        scheduleDecisions: upsert(state.scheduleDecisions, event.decision),
      };

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

  // A REST fallback for `view.run` specifically -- not steps/egress/approvals,
  // which stay SSE-only below. The stream can only replay what's still in the
  // runtime's in-memory event log (steps/egress/etc are NOT durable the way
  // the run row itself is -- see store/sqlite.ts), so a run whose history
  // didn't survive a server restart gets an open, healthy stream that replays
  // nothing: without this, the page hangs on "Connecting..." forever with no
  // error and no data. `run.updated` REPLACES state.run wholesale, so this is
  // safe to race against the stream's own replay in either order -- whichever
  // arrives second just reconfirms the same (or a fresher) run.
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    api
      .getRun(runId)
      .then(({ run }) => {
        if (!cancelled) dispatch({ type: 'run.updated', run });
      })
      .catch(() => {
        // A genuinely missing run: the page's own "connecting" state stays
        // as-is, which is honest -- there is nothing to show either way.
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

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
