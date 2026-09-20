import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import type { Step } from '@htn/shared';
import { msLabel } from '../../lib/format';

/**
 * Replay a FINISHED run on the graph canvas.
 *
 * Every step already carries startedAt / endedAt, so "what was the canvas
 * showing at time t" is a pure function of the steps -- no new data and nothing
 * stored. `replaySteps` returns copies with their status rewound to t; feed
 * them to GraphCanvas exactly where the live steps normally go.
 */

/** Total wall-clock length of a replay, however long the run really took. */
const PLAYBACK_MS = 10_000;

export interface ReplayWindow {
  start: number;
  end: number;
}

export function replayWindow(steps: Step[]): ReplayWindow | null {
  let start = Infinity;
  let end = -Infinity;
  for (const step of steps) {
    if (!step.startedAt) continue;
    start = Math.min(start, new Date(step.startedAt).getTime());
    end = Math.max(end, new Date(step.endedAt ?? step.startedAt).getTime());
  }
  return Number.isFinite(start) && end > start ? { start, end } : null;
}

/** Steps as they stood `offsetMs` after the run began. */
export function replaySteps(steps: Step[], window: ReplayWindow, offsetMs: number): Step[] {
  const at = window.start + offsetMs;
  return steps.map((step) => {
    const started = step.startedAt ? new Date(step.startedAt).getTime() : Infinity;
    if (at < started) return { ...step, status: 'pending' };
    const ended = step.endedAt ? new Date(step.endedAt).getTime() : -Infinity;
    if (at < ended) return { ...step, status: 'running' };
    return step;
  });
}

export function useReplay(window: ReplayWindow | null) {
  const total = window ? window.end - window.start : 0;
  const [offset, setOffset] = useState(0);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!playing || total === 0) return;
    let previous = performance.now();
    const tick = (now: number) => {
      const dt = now - previous;
      previous = now;
      let done = false;
      setOffset((current) => {
        const next = current + (dt / PLAYBACK_MS) * total;
        if (next >= total) {
          done = true;
          return total;
        }
        return next;
      });
      if (done) setPlaying(false);
      else raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== undefined) cancelAnimationFrame(raf.current);
    };
  }, [playing, total]);

  return {
    offset,
    total,
    playing,
    seek: (value: number) => {
      setPlaying(false);
      setOffset(Math.min(total, Math.max(0, value)));
    },
    toggle: () => {
      // Pressing play at the end starts over rather than doing nothing.
      if (!playing && offset >= total) setOffset(0);
      setPlaying((p) => !p);
    },
    restart: () => {
      setOffset(0);
      setPlaying(true);
    },
  };
}

export function ReplayBar({ replay }: { replay: ReturnType<typeof useReplay> }) {
  const { offset, total, playing, seek, toggle, restart } = replay;
  const label = useMemo(() => msLabel(offset) + ' / ' + msLabel(total), [offset, total]);

  return (
    <div className="mt-3 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause replay' : 'Play replay'}
        className="flex h-7 w-7 items-center justify-center rounded-md bg-sky-500 text-slate-950 hover:bg-sky-400"
      >
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={restart}
        aria-label="Restart replay"
        title="Restart"
        className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 ring-1 ring-inset ring-slate-700 hover:bg-slate-800 hover:text-slate-200"
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </button>
      <input
        type="range"
        min={0}
        max={total}
        step={Math.max(1, Math.round(total / 500))}
        value={offset}
        onChange={(event) => seek(Number(event.target.value))}
        aria-label="Replay position"
        className="h-1 flex-1 cursor-pointer accent-sky-500"
      />
      <span className="w-24 shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-400">
        {label}
      </span>
    </div>
  );
}
