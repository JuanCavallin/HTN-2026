import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { isTerminal, type AgentGraph, type Run, type RunAnalytics, type Step } from '@htn/shared';
import { msLabel } from '../../lib/format';
import { statusByNode } from '../graph/GraphCanvas';
import { NumberTicker } from '../ui/NumberTicker';
import { Stat } from '../ui/Stat';

/**
 * Live header strip for a run: how far along, what it has spent, how long it
 * has taken. Counters tick as steps arrive so a run visibly "spends" as it works.
 */
export function RunStats({
  run,
  graph,
  steps,
  analytics,
}: {
  run: Run;
  graph: AgentGraph | null;
  steps: Step[];
  analytics: RunAnalytics | null;
}) {
  const running = !isTerminal(run.status);

  // Re-render each second while running so elapsed time counts up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const start = new Date(run.createdAt).getTime();
  const end = running ? now : new Date(run.updatedAt).getTime();

  // Progress is measured in graph nodes when there is a graph (a known total),
  // and falls back to steps for hand-written playbooks.
  let done: number;
  let total: number;
  if (graph) {
    const statuses = statusByNode(steps);
    total = graph.nodes.length;
    done = [...statuses.values()].filter(
      (s) => s === 'succeeded' || s === 'failed' || s === 'skipped',
    ).length;
  } else {
    total = steps.length;
    done = steps.filter((s) => s.status !== 'pending' && s.status !== 'running').length;
  }
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;

  const totals = analytics?.totals;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label={graph ? 'Nodes' : 'Steps'}>
        <span>
          <NumberTicker value={done} />
          <span className="text-slate-500"> / {total}</span>
        </span>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-800">
          <motion.div
            className={
              'h-full rounded-full ' +
              (run.status === 'failed'
                ? 'bg-rose-400'
                : run.status === 'succeeded'
                  ? 'bg-emerald-400'
                  : 'bg-sky-400')
            }
            initial={false}
            animate={{ width: pct + '%' }}
            transition={{ type: 'spring', stiffness: 120, damping: 20 }}
          />
        </div>
      </Stat>

      <Stat label="Tokens">
        <NumberTicker value={totals ? totals.tokensIn + totals.tokensOut : 0} />
        {totals && totals.llmCalls > 0 && (
          <span className="ml-1.5 text-xs font-normal text-slate-500">
            {totals.llmCalls} call{totals.llmCalls === 1 ? '' : 's'}
          </span>
        )}
      </Stat>

      <Stat label="Est. cost">
        <NumberTicker value={totals?.estimatedCostCents ?? 0} decimals={4} suffix="¢" />
      </Stat>

      <Stat label="Elapsed">
        <span className="tabular-nums">{msLabel(Math.max(0, end - start))}</span>
      </Stat>
    </div>
  );
}
