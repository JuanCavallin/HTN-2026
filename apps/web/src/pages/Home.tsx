import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isTerminal } from '@htn/shared';
import { api } from '../lib/api';
import { useGraphs } from '../hooks/useGraph';
import { useRuns } from '../hooks/useRuns';
import { ActiveRunCard } from '../components/runs/ActiveRunCard';
import { RunList } from '../components/runs/RunList';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';

/**
 * Graphs only, deliberately -- a graph IS the task; a run is just one
 * attempt at it. Launching a raw playbook kind directly (skipping past a
 * graph entirely) used to be offered here too, but that's exactly the
 * "run with nothing to point back to, edit, or compare against" shape the
 * rest of this app (task history, Compare, Save as new task) assumes never
 * happens. `demo` and `baseline` stay registered and launchable via the API
 * for exactly what each is actually for -- demo as the works-even-if-graphs-
 * break fallback (see graph_demo, its graph-shaped equivalent, for the UI
 * path to the same behaviour), baseline only ever launched contextually
 * from GraphEditor's "Run + compare to baseline" button, never standalone.
 */
export function Home() {
  const navigate = useNavigate();
  const { runs, loading } = useRuns();
  const { graphs } = useGraphs();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedGraphId = selectedId ?? graphs[0]?.id ?? null;

  // Split once here rather than filtering inside two different components --
  // a run that just went terminal moves from the live grid to the plain list
  // on the very next `useRuns()` refresh (the global /api/stream already
  // drives that), with no risk of it briefly appearing in both.
  const activeRuns = runs.filter((run) => !isTerminal(run.status));
  const pastRuns = runs.filter((run) => isTerminal(run.status));

  const launch = async () => {
    if (!selectedGraphId) return;
    setLaunching(true);
    setError(null);
    try {
      const { run } = await api.runGraph(selectedGraphId, { target: 'ACME-2026-TERM-FEES' });
      navigate('/runs/' + run.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card title="Launch a run">
        <p className="mb-3 text-sm text-slate-400">
          Every run follows the same shape: it works through steps, fans out when there is
          independent work to do, and stops for you before anything irreversible.
        </p>

        {graphs.length === 0 ? (
          <p className="text-sm text-slate-500">
            No tasks yet —{' '}
            <button
              onClick={() => navigate('/graphs')}
              className="text-sky-400 underline underline-offset-2 hover:text-sky-300"
            >
              describe one
            </button>{' '}
            to get started.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedGraphId ?? ''}
              onChange={(event) => setSelectedId(event.target.value)}
              className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-200"
            >
              {graphs.map((graph) => (
                <option key={graph.id} value={graph.id}>
                  {graph.name}
                </option>
              ))}
            </select>

            <Button onClick={() => void launch()} disabled={launching || !selectedGraphId}>
              {launching ? 'Starting…' : 'Launch'}
            </Button>

            <Button variant="ghost" onClick={() => navigate('/graphs/' + selectedGraphId)}>
              Open in editor
            </Button>
          </div>
        )}

        {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}

        <p className="mt-3 text-xs text-slate-600">
          Runs with no API keys configured — every provider falls back to a mock.
        </p>
      </Card>

      {activeRuns.length > 0 && (
        <Card title={'Active now (' + activeRuns.length + ')'}>
          <div className="grid gap-2 sm:grid-cols-2">
            {activeRuns.map((run) => (
              <ActiveRunCard key={run.id} runId={run.id} />
            ))}
          </div>
        </Card>
      )}

      {(pastRuns.length > 0 || activeRuns.length === 0) && (
        <Card title="Runs">
          <RunList runs={pastRuns} loading={loading} />
        </Card>
      )}
    </div>
  );
}
