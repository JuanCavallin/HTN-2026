/**
 * Actions off a finished (or in-progress) run, all keyed off `run.graphId` --
 * the same "history of this task" query the Compare page's callers use.
 *
 * "Edit graph" points at the LIVE graph document (`/graphs/:graphId`), not
 * the run -- a run is a frozen attempt, editing happens on the task, not on
 * what already happened. It's offered for any run with a graphId, including
 * a baseline: editing the task it was compared against is exactly as
 * meaningful there. "Save as new task" is the one that instead points
 * backward, at the exact snapshot THIS run executed (only graph-kind runs
 * have one) -- the two are not the same action and don't substitute for
 * each other.
 *
 * "vs. baseline" and "vs. previous run" answer different questions (does the
 * structure help at all vs. did this edit help) and neither substitutes for
 * the other, so both are offered independently rather than one falling back
 * to the other. Either can be absent -- a graph's first run has no
 * predecessor, and a graph nobody has run a baseline against has no baseline
 * -- so each button only renders once its target actually exists.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Run } from '@htn/shared';
import { api, ApiError } from '../../lib/api';
import { Button } from '../ui/Button';

export function CompareLinks({ run }: { run: Run }) {
  const navigate = useNavigate();
  const [previousRun, setPreviousRun] = useState<Run | null | undefined>(undefined);
  const [baselineRun, setBaselineRun] = useState<Run | null | undefined>(undefined);
  const [forking, setForking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!run.graphId) {
      setPreviousRun(null);
      setBaselineRun(null);
      return;
    }
    api
      .listRuns({ graphId: run.graphId, limit: 10 })
      .then(({ runs }) => {
        const others = runs.filter((r) => r.id !== run.id);
        setPreviousRun(others[0] ?? null);
        setBaselineRun(others.find((r) => r.kind === 'baseline') ?? null);
      })
      .catch(() => {
        setPreviousRun(null);
        setBaselineRun(null);
      });
  }, [run.id, run.graphId]);

  const saveAsGraph = async () => {
    setForking(true);
    setError(null);
    try {
      const { graph } = await api.saveRunAsGraph(run.id);
      navigate('/graphs/' + graph.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setForking(false);
    }
  };

  const hasActions = run.graphId || previousRun || baselineRun || run.kind === 'graph';
  if (!hasActions) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {run.graphId && (
        <Button variant="ghost" onClick={() => navigate('/graphs/' + run.graphId)}>
          Edit graph
        </Button>
      )}
      {baselineRun && (
        <Button
          variant="ghost"
          onClick={() => navigate('/compare?a=' + run.id + '&b=' + baselineRun.id)}
        >
          Compare to baseline
        </Button>
      )}
      {previousRun && (
        <Button
          variant="ghost"
          onClick={() => navigate('/compare?a=' + previousRun.id + '&b=' + run.id)}
        >
          Compare to previous run
        </Button>
      )}
      {run.kind === 'graph' && (
        <Button variant="ghost" onClick={() => void saveAsGraph()} disabled={forking}>
          {forking ? 'Saving…' : 'Save as new task'}
        </Button>
      )}
      {error && <span className="text-xs text-rose-400">{error}</span>}
    </div>
  );
}
