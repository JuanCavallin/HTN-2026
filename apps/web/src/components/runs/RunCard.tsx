import { Link } from 'react-router-dom';
import type { Run } from '@htn/shared';
import { Badge } from '../ui/Badge';
import { humanStatus, relativeTime, RUN_STATUS_TONE } from '../../lib/format';

export function RunCard({ run }: { run: Run }) {
  return (
    <Link
      to={'/runs/' + run.id}
      className="block rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3 transition-colors hover:border-slate-700 hover:bg-slate-900"
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-slate-200">{run.title}</span>
        <Badge tone={RUN_STATUS_TONE[run.status]}>{humanStatus(run.status)}</Badge>
        <span className="ml-auto shrink-0 text-xs text-slate-600">
          {relativeTime(run.createdAt)}
        </span>
      </div>

      <p className="mt-1 truncate text-xs text-slate-500">
        {run.summary ?? run.kind + ' · ' + run.id}
      </p>
    </Link>
  );
}
