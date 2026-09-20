import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isTerminal, rollup } from '@htn/shared';
import { useRunStream } from '../hooks/useRunStream';
import { useRunGraph } from '../hooks/useGraph';
import { api } from '../lib/api';
import { humanStatus, relativeTime, RUN_STATUS_TONE } from '../lib/format';
import { ApprovalPanel } from '../components/approvals/ApprovalPanel';
import { handoffSessionIdFor } from '../lib/handoff';
import { EgressLedger } from '../components/egress/EgressLedger';
import { GraphCanvas } from '../components/graph/GraphCanvas';
import { Legend } from '../components/graph/Legend';
import { CompareLinks } from '../components/runs/CompareLinks';
import { RunDevProvider } from '../components/runs/RunDevContext';
import { StepTimeline } from '../components/runs/StepTimeline';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const {
    run,
    steps,
    approvals,
    egress,
    piiSpans,
    scheduleDecisions,
    browserSessions,
    logs,
    connected,
  } = useRunStream(id);

  // Resuming a handoff is the same POST an approval decision uses -- a handoff
  // IS an approval, with a browser attached. See interpreter.ts's runHandoff.
  const [resumeBusy, setResumeBusy] = useState(false);
  const resumeHandoff = async (approvalId: string) => {
    setResumeBusy(true);
    try {
      await api.decide(approvalId, { decision: 'approved' });
    } catch {
      // The approval panel below is still on screen and shows the same
      // action, so a failure here is recoverable without a second error path.
    } finally {
      setResumeBusy(false);
    }
  };

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

  // A pause is a WAIT, not an interrupt: nothing new starts, but whatever is
  // already in flight finishes on its own (see core/runGate.ts). `pausing`
  // vs `paused` is the difference between "draining" and "fully stopped" --
  // shown separately because a Hermes agent_task can hold the drain open for
  // a while, and that is expected, not stuck.
  const pausing = run.control === 'pausing';
  const paused = run.control === 'paused';
  const waitingOn = steps.filter((s) => s.status === 'running').map((s) => s.label);

  return (
    <div className="space-y-5">
      <div>
        <Link to="/" className="text-xs text-slate-500 hover:text-slate-300">
          ← All runs
        </Link>

        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-slate-100">{run.title}</h1>
          <Badge tone={RUN_STATUS_TONE[run.status]}>{humanStatus(run.status)}</Badge>
          {pausing && (
            <Badge tone="warn">
              <span className="flex items-center gap-1.5">
                <Spinner className="h-2 w-2" />
                pausing
              </span>
            </Badge>
          )}
          {paused && <Badge tone="muted">paused</Badge>}
          {connected && running && (
            <span className="flex items-center gap-1.5 text-xs text-slate-500">
              <Spinner className="h-2 w-2" />
              live
            </span>
          )}
          {running && (
            <div className="ml-auto flex items-center gap-2">
              {pausing || paused ? (
                <Button
                  variant="ghost"
                  onClick={() => void api.resumeRun(run.id).catch(() => undefined)}
                >
                  Resume
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => void api.pauseRun(run.id).catch(() => undefined)}
                >
                  Pause
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => void api.cancelRun(run.id).catch(() => undefined)}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>

        {pausing && (
          <p className="mt-1 text-xs text-amber-300">
            {waitingOn.length > 0
              ? 'Pausing — nothing new will start. Waiting on: ' + waitingOn.join(', ')
              : 'Pausing — nothing new will start. Finishing up…'}
          </p>
        )}

        <p className="mt-1 text-xs text-slate-600">
          {run.kind} · {run.id} · started {relativeTime(run.createdAt)}
        </p>

        {run.summary && <p className="mt-2 text-sm text-slate-300">{run.summary}</p>}

        <div className="mt-3">
          <CompareLinks run={run} />
        </div>
      </div>

      {pending.map((approval) => {
        const sessionId = handoffSessionIdFor(approval, browserSessions);
        return (
          <ApprovalPanel
            key={approval.id}
            approval={approval}
            {...(sessionId ? { handoffSessionId: sessionId } : {})}
          />
        );
      })}

      {graph && (
        <Card
          title="Graph"
          actions={
            analytics && (
              <span className="text-xs text-slate-500">
                {analytics.totals.tokensIn + analytics.totals.tokensOut} tokens ·{' '}
                {analytics.totals.llmCalls} model calls ·{' '}
                {analytics.totals.estimatedCostCents.toFixed(4)}¢
              </span>
            )
          }
        >
          <GraphCanvas
            graph={graph}
            steps={steps}
            analytics={analytics}
            browserSessions={browserSessions}
            approvals={approvals}
            onResumeHandoff={(approvalId) => void resumeHandoff(approvalId)}
            resumeBusy={resumeBusy}
            className="h-[460px]"
          />
          <div className="mt-3">
            <Legend compact />
          </div>
        </Card>
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
