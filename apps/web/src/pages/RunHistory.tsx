import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePlaybooks, useRuns } from '../hooks/useRuns';
import { api } from '../lib/api';
import { Icon } from '../components/ui/Icon';

export function RunHistory() {
  const { runs, error, loading, refresh } = useRuns();
  const playbooks = usePlaybooks().filter((playbook) => playbook.directLaunch);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState('');
  const [kind, setKind] = useState('');
  const filtered = useMemo(
    () =>
      runs
        .filter((run) => run.title.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [runs, query],
  );
  const launch = async () => {
    const selected = kind || playbooks[0]?.kind;
    if (!selected) return;
    setLaunching(true);
    setLaunchError('');
    try {
      const { run } = await api.createRun(selected, {});
      navigate('/runs/' + run.id);
    } catch (issue) {
      setLaunchError(issue instanceof Error ? issue.message : 'Could not launch the playbook.');
    } finally {
      setLaunching(false);
    }
  };
  return (
    <div className="library-page">
      <header className="library-heading">
        <div>
          <h1>Every run, in perspective.</h1>
          <p>Return to the decisions, outcomes, and details behind your work.</p>
        </div>
        <Link className="primary-button" to="/?new=1">
          <Icon name="plus" size={16} />
          New conversation
        </Link>
      </header>
      <div className="library-toolbar">
        <label className="search-field">
          <Icon name="search" size={17} />
          <input
            aria-label="Search runs"
            placeholder="Search your runs…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className="icon-button" aria-label="Refresh runs" onClick={() => void refresh()}>
          <Icon name="replay" size={17} />
        </button>
      </div>
      {error ? (
        <div className="library-empty">
          <Icon name="connect" size={30} />
          <h2>Your backend isn’t available.</h2>
          <p>Start the Zephyr API to load saved runs. Previews remain available without it.</p>
          <div className="approval-actions">
            <button className="secondary-button" onClick={() => void refresh()}>
              Try again
            </button>
            <Link className="text-link" to="/?example=support">
              Explore a preview <Icon name="arrow" size={14} />
            </Link>
          </div>
          <details>
            <summary>Connection details</summary>
            <p>{error}</p>
          </details>
        </div>
      ) : loading ? (
        <div className="library-empty" role="status">
          Loading your run history…
        </div>
      ) : !filtered.length ? (
        <div className="library-empty">
          <Icon name="clock" size={30} />
          <h2>{query ? 'No matching runs.' : 'Your next task starts the story.'}</h2>
          <p>
            {query
              ? 'Try a different search.'
              : 'Backend runs will appear here. Synthetic previews are kept separate.'}
          </p>
        </div>
      ) : (
        <div className="run-table">
          <div className="run-table-head">
            <span>Task</span>
            <span>Status</span>
            <span>Started</span>
            <span />
          </div>
          {filtered.map((run) => (
            <Link className="run-table-row" key={run.id} to={'/runs/' + run.id}>
              <span>
                <strong>{run.title}</strong>
                <small>
                  {run.kind} · {run.id}
                </small>
              </span>
              <span className={`run-status-label ${run.status}`}>
                {run.status.replaceAll('_', ' ')}
              </span>
              <time dateTime={run.createdAt}>
                {new Date(run.createdAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
              <Icon name="arrow" size={16} />
            </Link>
          ))}
        </div>
      )}
      {playbooks.length > 0 && (
        <section className="playbook-launch">
          <div>
            <h2>Start from a playbook</h2>
            <p>Launch a configured workflow using the existing backend.</p>
          </div>
          <select
            aria-label="Playbook"
            value={kind || playbooks[0]?.kind}
            onChange={(event) => setKind(event.target.value)}
          >
            {playbooks.map((playbook) => (
              <option key={playbook.kind} value={playbook.kind}>
                {playbook.title}
              </option>
            ))}
          </select>
          <button className="secondary-button" disabled={launching} onClick={() => void launch()}>
            <Icon name="play" size={15} />
            {launching ? 'Launching…' : 'Launch'}
          </button>
        </section>
      )}
      {launchError && (
        <p className="error-note" role="alert">
          {launchError}
        </p>
      )}
    </div>
  );
}
