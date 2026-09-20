import { Link } from 'react-router-dom';
import { useRunStream } from '../../hooks/useRunStream';
import { Badge } from '../ui/Badge';
import { Spinner } from '../ui/Spinner';
import { duration, humanStatus, RUN_STATUS_TONE } from '../../lib/format';

/**
 * One card in the "happening right now" dashboard section.
 *
 * Opens its own SSE stream via useRunStream -- safe here specifically
 * because Home.tsx only ever mounts this for a run whose last-known status
 * was non-terminal, and useRunStream closes its own connection the moment a
 * run reaches a terminal status (see that hook's comment on the browser's
 * ~6-connections-per-origin ceiling). A dashboard that opened one of these
 * per HISTORICAL run instead would be the thing that ceiling actually bites.
 */
export function ActiveRunCard({ runId }: { runId: string }) {
  const { run, steps, approvals } = useRunStream(runId);

  if (!run) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3 text-xs text-slate-600">
        <Spinner className="h-3 w-3" />
        connecting…
      </div>
    );
  }

  const finishedCount = steps.filter(
    (s) => s.status !== 'pending' && s.status !== 'running',
  ).length;
  const active = steps.find((s) => s.status === 'running' || s.status === 'blocked');
  const pendingApproval = approvals.find((a) => a.status === 'pending');

  return (
    <Link
      to={'/runs/' + run.id}
      className="block rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3 transition-colors hover:border-slate-700 hover:bg-slate-900"
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-slate-200">{run.title}</span>
        <Badge tone={RUN_STATUS_TONE[run.status]}>{humanStatus(run.status)}</Badge>
        {/* Operator pause is a separate axis from run.status -- see
            core/runGate.ts -- so it needs its own mark even on a run that
            still reads "running" underneath. */}
        {run.control === 'pausing' && <Badge tone="warn">pausing</Badge>}
        {run.control === 'paused' && <Badge tone="muted">paused</Badge>}
        <span className="ml-auto shrink-0 text-xs text-slate-600">{duration(run.createdAt)}</span>
      </div>

      <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-400">
        {run.status === 'running' && run.control !== 'paused' && (
          <Spinner className="h-3 w-3 shrink-0" />
        )}
        {pendingApproval ? (
          <span className="truncate text-amber-300">waiting on: {pendingApproval.question}</span>
        ) : active ? (
          <span className="truncate">{active.label}</span>
        ) : (
          <span className="truncate text-slate-600">{run.kind}</span>
        )}
        {steps.length > 0 && (
          <span className="ml-auto shrink-0 text-slate-600">
            {finishedCount}/{steps.length} steps
          </span>
        )}
      </div>
    </Link>
  );
}
