import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useGraphs } from '../hooks/useGraph';
import { usePlaybooks, useRuns } from '../hooks/useRuns';
import { RunList } from '../components/runs/RunList';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';

/**
 * One dropdown, two sources.
 *
 * A playbook with required input cannot be launched from a generic form -- the
 * `graph` playbook needs a graphId, and offering it here with an empty input is
 * a guaranteed validation error. So playbooks that say `directLaunch: false`
 * are excluded, and the graphs themselves are offered instead, each launching
 * with its own id.
 */
type LaunchOption =
  | { key: string; label: string; kind: 'playbook'; playbookKind: string }
  | { key: string; label: string; kind: 'graph'; graphId: string };

export function Home() {
  const navigate = useNavigate();
  const { runs, loading } = useRuns();
  const playbooks = usePlaybooks();
  const { graphs } = useGraphs();

  const options: LaunchOption[] = [
    ...playbooks
      .filter((playbook) => playbook.directLaunch)
      .map((playbook) => ({
        key: 'playbook:' + playbook.kind,
        label: playbook.title,
        kind: 'playbook' as const,
        playbookKind: playbook.kind,
      })),
    ...graphs.map((graph) => ({
      key: 'graph:' + graph.id,
      label: 'Graph — ' + graph.name,
      kind: 'graph' as const,
      graphId: graph.id,
    })),
  ];

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = options.find((o) => o.key === selectedKey) ?? options[0];

  const launch = async () => {
    if (!selected) return;
    setLaunching(true);
    setError(null);
    try {
      const { run } =
        selected.kind === 'graph'
          ? await api.runGraph(selected.graphId, { target: 'ACME-2026-TERM-FEES' })
          : await api.createRun(selected.playbookKind, {});
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

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selected?.key ?? ''}
            onChange={(event) => setSelectedKey(event.target.value)}
            className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-200"
          >
            {options.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>

          <Button onClick={() => void launch()} disabled={launching || options.length === 0}>
            {launching ? 'Starting…' : 'Launch'}
          </Button>

          {selected?.kind === 'graph' && (
            <Button variant="ghost" onClick={() => navigate('/graphs/' + selected.graphId)}>
              Open in editor
            </Button>
          )}
        </div>

        {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}

        <p className="mt-3 text-xs text-slate-600">
          Runs with no API keys configured — every provider falls back to a mock.
        </p>
      </Card>

      <Card title="Runs">
        <RunList runs={runs} loading={loading} />
      </Card>
    </div>
  );
}
