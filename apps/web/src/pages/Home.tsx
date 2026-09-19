import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { usePlaybooks, useRuns } from '../hooks/useRuns';
import { RunList } from '../components/runs/RunList';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';

export function Home() {
  const navigate = useNavigate();
  const { runs, loading } = useRuns();
  const playbooks = usePlaybooks();

  const [kind, setKind] = useState('demo');
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = async () => {
    setLaunching(true);
    setError(null);
    try {
      const { run } = await api.createRun(kind, {});
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
          Every playbook follows the same shape: it works through steps, fans out when there is
          independent work to do, and stops for you before anything irreversible.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-200"
          >
            {playbooks.map((playbook) => (
              <option key={playbook.kind} value={playbook.kind}>
                {playbook.title}
              </option>
            ))}
          </select>

          <Button onClick={() => void launch()} disabled={launching || playbooks.length === 0}>
            {launching ? 'Starting…' : 'Launch'}
          </Button>
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
