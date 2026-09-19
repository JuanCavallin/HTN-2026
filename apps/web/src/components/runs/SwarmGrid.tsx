import type { Step } from '@htn/shared';
import { Spinner } from '../ui/Spinner';
import { duration } from '../../lib/format';

/**
 * The parallel workers of one fan-out. Visually the most valuable 30 seconds of
 * a demo, and it costs nothing extra: these are just steps sharing a parentStepId.
 */
export function SwarmGrid({ workers }: { workers: Step[] }) {
  const done = workers.filter((w) => w.status === 'succeeded' || w.status === 'failed').length;

  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/40 p-2">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-slate-500">
        <span>
          {done} / {workers.length} workers complete
        </span>
        {done < workers.length && <Spinner className="h-2.5 w-2.5" />}
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {workers.map((worker) => (
          <div
            key={worker.id}
            className={
              'rounded border px-2 py-1.5 text-xs transition-colors ' +
              (worker.status === 'succeeded'
                ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-200'
                : worker.status === 'failed'
                  ? 'border-rose-500/25 bg-rose-500/5 text-rose-200'
                  : 'border-slate-700 bg-slate-900/60 text-slate-300')
            }
          >
            <div className="flex items-center gap-1.5">
              {worker.status === 'running' && <Spinner className="h-2.5 w-2.5" />}
              <span className="truncate">{worker.label}</span>
            </div>
            <div className="mt-0.5 text-[10px] text-slate-500">
              {worker.status === 'running'
                ? 'working…'
                : duration(worker.startedAt, worker.endedAt)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
