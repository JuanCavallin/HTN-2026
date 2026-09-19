import { Link, useParams } from 'react-router-dom';
import { isTerminal } from '@htn/shared';
import { useRunStream } from '../hooks/useRunStream';
import { api } from '../lib/api';
import { humanStatus, relativeTime, RUN_STATUS_TONE } from '../lib/format';
import { ApprovalPanel } from '../components/approvals/ApprovalPanel';
import { EgressLedger } from '../components/egress/EgressLedger';
import { StepTimeline } from '../components/runs/StepTimeline';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const { run, steps, approvals, egress, piiSpans, logs, connected } = useRunStream(id);

  if (!run) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner />
        Connecting to run {id}…
      </div>
    );
  }

  const pending = approvals.filter((a) => a.status === 'pending');
  const running = !isTerminal(run.status);

  return (
    <div className="space-y-5">
      <div>
        <Link to="/" className="text-xs text-slate-500 hover:text-slate-300">
          ← All runs
        </Link>

        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-slate-100">{run.title}</h1>
          <Badge tone={RUN_STATUS_TONE[run.status]}>{humanStatus(run.status)}</Badge>
          {connected && running && (
            <span className="flex items-center gap-1.5 text-xs text-slate-500">
              <Spinner className="h-2 w-2" />
              live
            </span>
          )}
          {running && (
            <Button
              variant="ghost"
              className="ml-auto"
              onClick={() => void api.cancelRun(run.id).catch(() => undefined)}
            >
              Cancel
            </Button>
          )}
        </div>

        <p className="mt-1 text-xs text-slate-600">
          {run.kind} · {run.id} · started {relativeTime(run.createdAt)}
        </p>

        {run.summary && <p className="mt-2 text-sm text-slate-300">{run.summary}</p>}
      </div>

      {pending.map((approval) => (
        <ApprovalPanel key={approval.id} approval={approval} />
      ))}

      <Card title="Steps">
        <StepTimeline steps={steps} />
      </Card>

      <Card title="Egress ledger">
        <EgressLedger events={egress} piiSpans={piiSpans} />
      </Card>

      {run.result !== undefined && (
        <Card title="Result">
          <pre className="overflow-x-auto text-[11px] leading-relaxed text-slate-400">
            {JSON.stringify(run.result, null, 2)}
          </pre>
        </Card>
      )}

      {logs.length > 0 && (
        <Card title="Log">
          <ul className="space-y-0.5 text-[11px] text-slate-500">
            {logs.map((entry, index) => (
              <li key={index}>
                <span className="text-slate-700">{entry.at.slice(11, 19)}</span> {entry.message}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
