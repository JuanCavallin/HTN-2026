import { useState, type FormEvent } from 'react';
import { Icon } from '../ui/Icon';
import {
  canInterveneLive,
  formatCost,
  formatDuration,
  LIVE_INTERVENTION_REASON,
  ROUTE_OPTIONS,
  type RouteOption,
  type Trace,
} from '../../lib/workspace';

export function TaskComposer({
  onSend,
  busy = false,
  disabled = false,
  mode,
  onModeChange,
  placeholder = 'Ask anything. See every step.',
  hint,
}: {
  onSend: (text: string) => Promise<boolean>;
  busy?: boolean;
  disabled?: boolean;
  mode: 'preview' | 'backend';
  onModeChange?: (mode: 'preview' | 'backend') => void;
  placeholder?: string;
  hint?: string;
}) {
  const [text, setText] = useState('');
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!text.trim() || busy || disabled) return;
    if (await onSend(text.trim())) setText('');
  };
  return (
    <div className="composer-dock">
      <form className="composer" onSubmit={(event) => void submit(event)}>
        <label className="sr-only" htmlFor="task-message">
          Message Zephyr
        </label>
        <textarea
          id="task-message"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholder}
          rows={2}
          maxLength={4000}
          disabled={busy || disabled}
        />
        <div className="composer-actions">
          <div className="composer-mode">
            <Icon name={mode === 'preview' ? 'play' : 'connect'} size={14} />
            {onModeChange ? (
              <select
                aria-label="Execution mode"
                value={mode}
                disabled={busy}
                onChange={(event) => onModeChange(event.target.value as 'preview' | 'backend')}
              >
                <option value="preview">Preview mode</option>
                <option value="backend">Use backend</option>
              </select>
            ) : (
              <span>Backend run</span>
            )}
          </div>
          <span className="composer-shortcut">Shift + Enter for a new line</span>
          <button
            className="send-button"
            type="submit"
            aria-label={busy ? 'Preparing your task' : 'Send message'}
            disabled={busy || disabled || !text.trim()}
          >
            <Icon name={busy ? 'activity' : 'send'} size={18} />
          </button>
        </div>
      </form>
      <p className="composer-disclaimer">
        {hint ??
          (mode === 'preview'
            ? 'Preview uses synthetic data. No models or tools are called.'
            : 'Sending starts a workflow. Required action approvals still apply.')}
      </p>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  ready: 'Ready',
  pending: 'Preparing',
  running: 'Running',
  succeeded: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  awaiting_approval: 'Needs approval',
  paused: 'Paused',
};

/**
 * The fixed floor: status, controls, measurements and what is running right now.
 *
 * Split out of the old `ExecutionRail` so that measurement never competes with the graph
 * for horizontal space. The class names the browser suite asserts on (`.run-status`,
 * `.run-metrics`, `.elapsed-time`, `.current-work`) live here and are load-bearing.
 */
export function MetricsStrip({
  trace,
  paused = false,
  onPause,
  onReplay,
  onCancel,
  connected,
  lastEventAt,
}: {
  trace: Trace;
  paused?: boolean;
  onPause?: () => void;
  onReplay?: () => void;
  onCancel?: () => void;
  connected?: boolean;
  lastEventAt?: number | null;
}) {
  const completed = trace.nodes.filter((item) => item.status === 'succeeded').length;
  const active = trace.nodes.filter((item) => item.status === 'running');
  // A paused run is still an ACTIVE run -- it is exactly the run whose pause
  // control has to stay on screen, so that resume is reachable.
  const running = trace.status === 'running' || trace.status === 'paused';
  const preview = trace.provenance === 'preview';
  const lastEventSeconds = lastEventAt
    ? Math.max(0, Math.floor((Date.now() - lastEventAt) / 1000))
    : null;
  return (
    <aside className="metrics-strip" aria-label="Run controls and measurements">
      <div className="strip-status">
        <div className="run-status">
          <span className={`status-dot ${running && !paused ? 'live-dot' : 'quiet'}`} />
          <span className={trace.status === 'awaiting_approval' ? 'warning-text' : ''}>
            {paused && trace.status === 'running'
              ? 'Paused'
              : (STATUS_LABELS[trace.status] ?? trace.status)}
          </span>
          <span className="subtle-tag">
            {preview ? 'Preview' : trace.provenance === 'unknown' ? 'Backend' : trace.provenance}
          </span>
        </div>
        <div className="task-progress">
          <div>
            <span>Steps completed</span>
            <strong>
              {completed}
              <span> / {trace.nodes.length}</span>
            </strong>
          </div>
          <progress
            value={completed}
            max={Math.max(1, trace.nodes.length)}
            aria-label="Completed execution steps"
          />
        </div>
      </div>

      <dl className="run-metrics">
        <div>
          <dt>
            <Icon name="tokens" size={14} />
            Tokens used
          </dt>
          <dd>
            {trace.tokens === undefined ? '—' : trace.tokens.toLocaleString()}
            <small>{preview ? 'illustrative' : 'reported so far'}</small>
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="cost" size={14} />
            Estimated cost
          </dt>
          <dd>
            {formatCost(trace.costCents)}
            <small>USD{preview ? ' · illustrative' : ' · reported so far'}</small>
          </dd>
        </div>
        <div>
          <dt>
            <Icon name="clock" size={14} />
            Elapsed time
          </dt>
          <dd className="elapsed-time">
            {formatDuration(trace.elapsedMs)}
            <small>
              {paused ? 'preview clock paused' : preview ? 'preview clock' : 'wall-clock time'}
            </small>
          </dd>
        </div>
      </dl>

      <section className="current-work">
        <h3>
          {trace.status === 'awaiting_approval' ? 'Your attention is needed' : 'Current work'}
        </h3>
        {active.length ? (
          active.map((item) => (
            <div className="current-work-item" key={item.id}>
              <span className={`working-dot ${paused ? 'paused' : ''}`} />
              <span>{item.label}</span>
            </div>
          ))
        ) : (
          <p>
            {trace.status === 'succeeded'
              ? 'All work is complete.'
              : trace.status === 'awaiting_approval'
                ? 'Review the proposed action before continuing.'
                : trace.nodes.length
                  ? 'No steps currently executing.'
                  : 'Send a task to begin.'}
          </p>
        )}
      </section>

      <div className="strip-controls">
        <div className="execution-actions">
          {onPause && running ? (
            <button className={paused ? 'primary-button' : 'secondary-button'} onClick={onPause}>
              <Icon name={paused ? 'play' : 'pause'} size={15} />
              {paused ? 'Resume workflow' : 'Pause workflow'}
            </button>
          ) : preview && onReplay ? (
            <button className="secondary-button" onClick={onReplay}>
              <Icon name="replay" size={15} />
              Replay example
            </button>
          ) : (
            <button
              className="secondary-button"
              disabled
              title="This view replays a finished run, so there is nothing to pause"
            >
              <Icon name="pause" size={15} />
              Nothing to pause
            </button>
          )}
          {onCancel && !['succeeded', 'cancelled', 'failed'].includes(trace.status) && (
            <button
              className="icon-button cancel-run"
              aria-label="Cancel run"
              title="Cancel run"
              onClick={onCancel}
            >
              <Icon name="stop" size={15} />
            </button>
          )}
        </div>
        <p className="rail-foot">
          <Icon name={preview ? 'play' : connected ? 'activity' : 'connect'} size={13} />
          <span>
            {preview
              ? 'Synthetic demonstration'
              : connected
                ? lastEventSeconds !== null
                  ? `Connected · event ${lastEventSeconds}s ago`
                  : 'Event stream connected'
                : ['succeeded', 'cancelled', 'failed'].includes(trace.status)
                  ? 'Execution finished'
                  : 'Reconnecting to event stream…'}
          </span>
        </p>
      </div>
    </aside>
  );
}

/**
 * Opens on selection at the right of the graph. Holds the recorded decision and, where the
 * surface supports it, the control to change that node's route.
 */
export function RunInspector({
  trace,
  selected,
  onDeselect,
  override,
  onOverride,
}: {
  trace: Trace;
  selected: string;
  onDeselect: () => void;
  override?: RouteOption;
  onOverride?: (nodeId: string, route: RouteOption) => void;
}) {
  const [editing, setEditing] = useState(false);
  const node = trace.nodes.find((item) => item.id === selected);
  if (!node) return null;
  const preview = trace.provenance === 'preview';
  // Preview owns its own clock, so the whole loop is real there. A live run executes a
  // snapshot and exposes no pause, so the same control ships disabled with its reason.
  const editable = preview ? !!onOverride : canInterveneLive;

  return (
    <aside className="inspector-dock" aria-label="Selected decision">
      <section className="decision-inspector">
        <header>
          <h3>Decision detail</h3>
          <button className="icon-button" aria-label="Close decision detail" onClick={onDeselect}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <strong>{node.label}</strong>
        <span className="inspector-route">{node.route}</span>
        {node.planned && (
          <p className="inspector-flag">
            <Icon name="graph" size={13} />
            Planned structure. No execution has been reported for this node, so it carries no
            measurements.
          </p>
        )}
        {node.unplanned && (
          <p className="inspector-flag runtime">
            <Icon name="spark" size={13} />
            Created at runtime. This node was never in the plan — the executing step fanned it out.
          </p>
        )}
        <p>{node.detail}</p>
        <dl>
          <div>
            <dt>Duration</dt>
            <dd>{formatDuration(node.durationMs)}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{node.tokens?.toLocaleString() ?? '—'}</dd>
          </div>
          <div>
            <dt>Est. cost</dt>
            <dd>{formatCost(node.costCents)}</dd>
          </div>
          {node.decision && (
            <>
              <div>
                <dt>Confidence</dt>
                <dd>{(node.decision.confidence * 100).toFixed(0)}%</dd>
              </div>
              <div>
                <dt>Tools exposed</dt>
                <dd>
                  {node.decision.exposedTools.length} / {node.decision.availableTools.length}
                </dd>
              </div>
            </>
          )}
        </dl>
        {node.decision?.exposedTools.length ? (
          <div className="tool-tags">
            {node.decision.exposedTools.map((tool) => (
              <span key={tool}>{tool}</span>
            ))}
          </div>
        ) : null}

        <div className="inspector-edit">
          {editable && editing ? (
            <fieldset className="route-choices">
              <legend>Run this step on</legend>
              {ROUTE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  className={`route-choice ${override === option.id ? 'chosen' : ''}`}
                  aria-pressed={override === option.id}
                  onClick={() => {
                    onOverride?.(node.id, option.id);
                    setEditing(false);
                  }}
                >
                  <strong>{option.label}</strong>
                  <small>{option.note}</small>
                </button>
              ))}
              <button className="text-link" onClick={() => setEditing(false)}>
                Keep the recorded route
              </button>
            </fieldset>
          ) : editable ? (
            <button className="secondary-button full-width" onClick={() => setEditing(true)}>
              <Icon name="settings" size={14} />
              Change this step’s route
            </button>
          ) : (
            <>
              <button
                className="secondary-button full-width"
                disabled
                title={LIVE_INTERVENTION_REASON}
              >
                <Icon name="settings" size={14} />
                Editing unavailable
              </button>
              <p className="inspector-reason">{LIVE_INTERVENTION_REASON}</p>
            </>
          )}
          {editable && preview && (
            <p className="inspector-reason">
              Changing the route restarts this preview from the beginning with the new choice. It is
              a simulation — no model or tool is called.
            </p>
          )}
        </div>
      </section>
    </aside>
  );
}
