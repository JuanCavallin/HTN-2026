import { Check, X } from 'lucide-react';
import { motion } from 'motion/react';
import type { Step } from '@htn/shared';
import { Spinner } from '../ui/Spinner';
import { duration } from '../../lib/format';

/**
 * The parallel workers of one fan-out. Visually the most valuable 30 seconds of
 * a demo, and it costs nothing extra: these are just steps sharing a parentStepId.
 *
 * Tiles spring in as workers are spawned (staggered, so a fan-out reads as a
 * burst rather than a pop) and stamp a check or cross as each one finishes.
 */
export function SwarmGrid({ workers }: { workers: Step[] }) {
  const done = workers.filter((w) => w.status === 'succeeded' || w.status === 'failed').length;
  const pct = workers.length > 0 ? (done / workers.length) * 100 : 0;

  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/40 p-2">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-slate-500">
        <span>
          {done} / {workers.length} workers complete
        </span>
        {done < workers.length && <Spinner className="h-2.5 w-2.5" />}
      </div>
      <div className="mb-2 h-0.5 overflow-hidden rounded-full bg-slate-800">
        <motion.div
          className="h-full rounded-full bg-sky-400"
          initial={false}
          animate={{ width: pct + '%' }}
          transition={{ type: 'spring', stiffness: 140, damping: 22 }}
        />
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {workers.map((worker, index) => (
          <motion.div
            key={worker.id}
            layout
            initial={{ opacity: 0, scale: 0.9, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{
              type: 'spring',
              stiffness: 380,
              damping: 26,
              delay: Math.min(index, 8) * 0.04,
            }}
            className={
              'rounded border px-2 py-1.5 text-xs transition-colors duration-300 ' +
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
              {worker.status === 'succeeded' && (
                <motion.span
                  initial={{ scale: 0.3, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 18 }}
                  className="ml-auto text-emerald-400"
                >
                  <Check className="h-3 w-3" strokeWidth={3} aria-label="succeeded" />
                </motion.span>
              )}
              {worker.status === 'failed' && (
                <motion.span
                  initial={{ scale: 0.3, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="ml-auto text-rose-400"
                >
                  <X className="h-3 w-3" strokeWidth={3} aria-label="failed" />
                </motion.span>
              )}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-500">
              {worker.status === 'running'
                ? 'working…'
                : duration(worker.startedAt, worker.endedAt)}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
