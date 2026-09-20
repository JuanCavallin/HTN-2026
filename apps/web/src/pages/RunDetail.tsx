import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { History } from 'lucide-react';
import { toast } from 'sonner';
import { isTerminal, rollup } from '@htn/shared';
import { useRunStream } from '../hooks/useRunStream';
import { useRunGraph } from '../hooks/useGraph';
import { api } from '../lib/api';
import { humanStatus, relativeTime, RUN_STATUS_TONE } from '../lib/format';
import { ApprovalPanel } from '../components/approvals/ApprovalPanel';
import { EgressLedger } from '../components/egress/EgressLedger';
import { GraphCanvas } from '../components/graph/GraphCanvas';
import { Legend } from '../components/graph/Legend';
import { CompareLinks } from '../components/runs/CompareLinks';
import { RunDevProvider } from '../components/runs/RunDevContext';
import { ReplayBar, replaySteps, replayWindow, useReplay } from '../components/runs/RunReplay';
import { RunStats } from '../components/runs/RunStats';
import { StepTimeline } from '../components/runs/StepTimeline';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { JsonView } from '../components/ui/JsonView';
import { Spinner } from '../components/ui/Spinner';

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const { run, steps, approvals, egress, piiSpans, scheduleDecisions, logs, connected } =
    useRunStream(id);

  // Sticky across runs and reloads: someone debugging a harness wants every
  // run they open to come up expanded, not to re-flip the switch each time.
  // Read lazily so the first paint already has the right state.
  const [devMode, setDevMode] = useState(() => {
    try {
      return localStorage.getItem('htn.devView') === '1';
    } catch {
      // Private mode / blocked storage. Defaulting to off is the honest
      // fallback; the switch still works for this session.
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('htn.devView', devMode ? '1' : '0');
    } catch {
      /* not worth surfacing -- the toggle still works in-session */
    }
  }, [devMode]);

  const devValue = useMemo(
    () => ({ egress, scheduleDecisions, logs, devMode }),
    [egress, scheduleDecisions, logs, devMode],
  );

  // The graph this run executed. Uses the run's own snapshot, so editing the
  // graph afterwards never changes what this page shows.
  const graph = useRunGraph(run?.input ?? null);

  // THE SAME rollup() the API serves at /runs/:id/analytics, run client-side
  // over the stream. No request, and the numbers update live as steps arrive.
  const analytics = useMemo(
    () => (run ? rollup({ run, steps, egress, scheduleDecisions, approvals }) : null),
    [run, steps, egress, scheduleDecisions, approvals],
  );

  // Replay: only for a finished run whose steps carry timestamps.
  const replayWin = useMemo(() => replayWindow(steps), [steps]);
  const replay = useReplay(replayWin);
  const [replaying, setReplaying] = useState(false);
  const replayable = !!graph && !!run && isTerminal(run.status) && replayWin !== null;
  const toggleReplay = () => {
    if (replaying) {
      setReplaying(false);
    } else {
      setReplaying(true);
      replay.restart();
    }
  };

  // Tell the person the moment a run stops for them, even if this tab is in the
  // background: a toast, plus the tab title so it shows in the tab strip.
  const toasted = useRef(new Set<string>());
  const pendingCount = approvals.filter((a) => a.status === 'pending').length;
  useEffect(() => {
    for (const approval of approvals) {
      if (approval.status === 'pending' && !toasted.current.has(approval.id)) {
        toasted.current.add(approval.id);
        toast.warning('Approval needed', { description: approval.question, duration: 8000 });
      }
    }
  }, [approvals]);
  useEffect(() => {
    if (pendingCount === 0) return;
    const original = document.title;
    document.title = '⚠ Approval needed — ' + original;
    return () => {
      document.title = original;
    };
  }, [pendingCount]);

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

        <div className="mt-3">
          <CompareLinks run={run} />
        </div>
      </div>

      <RunStats run={run} graph={graph} steps={steps} analytics={analytics} />

      {pending.map((approval) => (
        <ApprovalPanel key={approval.id} approval={approval} />
      ))}

      {/* Canvas and timeline side by side on wide screens; the canvas stays
          pinned while the timeline scrolls, so you can watch the graph and
          read the step you are on without scrolling back up. */}
      <div className={graph ? 'grid items-start gap-5 xl:grid-cols-[3fr_2fr]' : ''}>
        {graph && (
          <div className="xl:sticky xl:top-16">
            <Card
              title="Graph"
              actions={
                replayable && (
                  <button
                    type="button"
                    onClick={toggleReplay}
                    aria-pressed={replaying}
                    className={
                      'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ' +
                      (replaying
                        ? 'border-sky-500/50 bg-sky-500/15 text-sky-300'
                        : 'border-slate-700 text-slate-400 hover:text-slate-200')
                    }
                  >
                    <History className="h-3 w-3" />
                    {replaying ? 'Exit replay' : 'Replay'}
                  </button>
                )
              }
            >
              <GraphCanvas
                graph={graph}
                steps={
                  replaying && replayWin ? replaySteps(steps, replayWin, replay.offset) : steps
                }
                // Node metrics are end-of-run totals; mid-replay they would
                // show spend that hasn't "happened" yet.
                analytics={replaying ? null : analytics}
                // Leave room under the canvas for the replay bar when it is up.
                className={
                  'h-[420px] xl:min-h-[380px] ' +
                  (replaying ? 'xl:h-[calc(100vh-20rem)]' : 'xl:h-[calc(100vh-15rem)]')
                }
              />
              {replaying && <ReplayBar replay={replay} />}
              <div className="mt-3">
                <Legend compact />
              </div>
            </Card>
          </div>
        )}

        {/* Kept alongside the canvas on purpose: the timeline is the fallback
            that works for every run, including hand-written playbooks with no
            graph behind them. */}
        <Card
          title="Steps"
          actions={
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300">
              <input
                type="checkbox"
                checked={devMode}
                onChange={(e) => setDevMode(e.target.checked)}
                className="h-3 w-3 accent-sky-500"
              />
              Dev view
            </label>
          }
        >
          <RunDevProvider value={devValue}>
            <StepTimeline steps={steps} run={run} />
          </RunDevProvider>
        </Card>
      </div>

      <Card title="Egress ledger">
        <EgressLedger events={egress} piiSpans={piiSpans} />
      </Card>

      {run.result !== undefined && (
        <Card title="Result">
          <JsonView value={run.result} className="max-h-96" />
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
