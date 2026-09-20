import { useAutoAnimate } from '@formkit/auto-animate/react';
import type { Run } from '@htn/shared';
import { Skeleton } from '../ui/Skeleton';
import { RunCard } from './RunCard';

export function RunList({ runs, loading }: { runs: Run[]; loading: boolean }) {
  // Cards slide into place when a run finishes and moves down from "active".
  const [listRef] = useAutoAnimate<HTMLDivElement>({ duration: 220 });

  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[3.75rem]" />
        ))}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No runs yet. Launch one above — it works with no API keys configured.
      </p>
    );
  }

  return (
    <div ref={listRef} className="space-y-2">
      {runs.map((run) => (
        <RunCard key={run.id} run={run} />
      ))}
    </div>
  );
}
