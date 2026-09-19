import type { Run } from '@htn/shared';
import { RunCard } from './RunCard';

export function RunList({ runs, loading }: { runs: Run[]; loading: boolean }) {
  if (loading) return <p className="text-sm text-slate-500">Loading runs…</p>;

  if (runs.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No runs yet. Launch one above — it works with no API keys configured.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <RunCard key={run.id} run={run} />
      ))}
    </div>
  );
}
