import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { emptyRunView, isTerminal, type AgentGraph, type Conversation } from '@htn/shared';
import { api } from '../lib/api';
import {
  advancePreview,
  buildTrace,
  previewTrace,
  PREVIEW_LIMIT,
  SCENARIOS,
  type RouteOption,
  type RouteOverrides,
  type Scenario,
  type Trace,
} from '../lib/workspace';
import { useRunStream } from '../hooks/useRunStream';
import { useRunGraph } from '../hooks/useGraph';
import { useHarness } from '../components/layout/AppShell';
import { DecisionCanvas } from '../components/graph/DecisionCanvas';
import { MetricsStrip, RunInspector, TaskComposer } from '../components/chat/WorkspacePanels';
import { ApprovalPanel } from '../components/approvals/ApprovalPanel';
import { EgressLedger } from '../components/egress/EgressLedger';
import { Icon, Mark } from '../components/ui/Icon';

function WorkingStatus({ children, active = true }: { children: ReactNode; active?: boolean }) {
  return (
    <div className={`working-status ${active ? 'is-working' : ''}`} role="status">
      <span className="working-bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{children}</span>
    </div>
  );
}

function Message({ author, children }: { author: 'you' | 'agent'; children: ReactNode }) {
  return (
    <div className={`message message-${author}`}>
      <div className="message-avatar">{author === 'you' ? 'You' : <Mark small />}</div>
      <div className="message-body">
        <div className="message-author">{author === 'you' ? 'You' : 'Zephyr'}</div>
        {children}
      </div>
    </div>
  );
}

function EmptyWorkspace({ onExample }: { onExample: (scenario: Scenario) => void }) {
  return (
    <div className="empty-workspace">
      <div className="empty-mark">
        <Mark />
      </div>
      <h1>
        Big tasks.
        <br />
        <span>A clear path forward.</span>
      </h1>
      <p>
        Ask a question or hand over a task.
        <br />
        See the decisions, not just the answer.
      </p>
      <div className="starter-prompts">
        <button onClick={() => onExample('support')}>
          <Icon name="file" />
          <span>
            <strong>Research high-risk accounts</strong>
            <small>Private context. Public signals. Your approval.</small>
          </span>
          <Icon name="arrow" size={16} />
        </button>
        <button onClick={() => onExample('trip')}>
          <Icon name="globe" />
          <span>
            <strong>Plan a weekend in Toronto</strong>
            <small>Explore parallel research and a clear result.</small>
          </span>
          <Icon name="arrow" size={16} />
        </button>
      </div>
      <span className="empty-footnote">Examples run as labeled, synthetic previews.</span>
    </div>
  );
}

/** Resize bounds for the conversation lane. Below the minimum it stops being readable. */
const LANE_MIN = 260;
const LANE_MAX_RATIO = 0.62;

/**
 * The hybrid shell, shared by the preview workspace and a live run.
 *
 * Three regions plus a floor: a conversation lane, the graph as the dominant centre region,
 * an inspector that opens on selection, and a fixed metrics strip. Selecting a node animates
 * the reflow — the graph gives up width and the inspector opens — which is the signature
 * interaction on this surface.
 */
function WorkspaceShell({
  trace,
  selected,
  onSelect,
  onDeselect,
  paused,
  lane,
  composer,
  scrollRef,
  onLaneScroll,
  override,
  onOverride,
  metrics,
}: {
  trace: Trace;
  selected?: string;
  onSelect: (id: string) => void;
  onDeselect: () => void;
  paused: boolean;
  lane: ReactNode;
  composer: ReactNode;
  scrollRef?: React.Ref<HTMLDivElement>;
  onLaneScroll?: React.UIEventHandler<HTMLDivElement>;
  override?: RouteOption;
  onOverride?: (nodeId: string, route: RouteOption) => void;
  metrics: ReactNode;
}) {
  const open = !!selected && trace.nodes.some((node) => node.id === selected);
  // Either pane can be given the whole width. Only one can be collapsed at a time, so
  // hiding one always reveals the other rather than leaving an empty workspace.
  const [view, setView] = useState<'split' | 'chat' | 'graph'>('split');
  const chatOpen = view !== 'graph';
  const graphOpen = view !== 'chat';

  // Dragging the rail resizes the split. The width is kept here and applied as
  // `--lane-width`, which every breakpoint's grid reads, so one inline value overrides the
  // responsive default without a second source of truth.
  const shell = useRef<HTMLDivElement>(null);
  const [laneWidth, setLaneWidth] = useState<number>();
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);

  const laneNow = () =>
    laneWidth ?? shell.current?.querySelector('.conversation-lane')?.clientWidth ?? LANE_MIN;
  const clampLane = (px: number) => {
    const total = shell.current?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.round(Math.min(Math.max(px, LANE_MIN), Math.max(LANE_MIN, total * LANE_MAX_RATIO)));
  };

  return (
    <div
      className="workspace-hybrid"
      ref={shell}
      data-inspector={open && graphOpen ? 'open' : 'closed'}
      data-view={view}
      data-dragging={dragging ? 'true' : undefined}
      // Always define the property. React does not reliably remove a custom property when
      // the style object goes away, so "unset" is expressed as the responsive default.
      style={
        {
          '--lane-width': laneWidth === undefined ? 'var(--lane-w)' : `${laneWidth}px`,
        } as CSSProperties
      }
    >
      <div className="conversation-lane" aria-hidden={!chatOpen} inert={!chatOpen || undefined}>
        <div className="conversation-scroll" ref={scrollRef} onScroll={onLaneScroll}>
          {lane}
        </div>
        {composer}
      </div>
      <div className="pane-rail">
        <button
          className="pane-toggle"
          aria-pressed={!chatOpen}
          aria-label={chatOpen ? 'Hide the conversation' : 'Show the conversation'}
          title={chatOpen ? 'Hide the conversation' : 'Show the conversation'}
          onClick={() => setView(chatOpen ? 'graph' : 'split')}
        >
          <Icon name={chatOpen ? 'chevronLeft' : 'chevronRight'} size={14} />
          <span className="sr-only">Conversation</span>
        </button>
        <div
          className="pane-rail-grip"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the conversation and the graph"
          title="Drag to resize · double-click to reset"
          tabIndex={view === 'split' ? 0 : -1}
          onPointerDown={(event) => {
            if (view !== 'split' || event.button !== 0) return;
            // Record the grab point and resize by delta. Jumping the divider to the cursor
            // on mousedown would make a plain click move the layout.
            drag.current = { x: event.clientX, width: laneNow() };
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (!dragging || !drag.current) return;
            setLaneWidth(clampLane(drag.current.width + (event.clientX - drag.current.x)));
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture(event.pointerId);
            setDragging(false);
            drag.current = undefined;
          }}
          onLostPointerCapture={() => setDragging(false)}
          onDoubleClick={() => setLaneWidth(undefined)}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 64 : 16;
            if (event.key === 'ArrowLeft') setLaneWidth(clampLane(laneNow() - step));
            else if (event.key === 'ArrowRight') setLaneWidth(clampLane(laneNow() + step));
            else if (event.key === 'Home' || event.key === 'Escape') setLaneWidth(undefined);
            else return;
            event.preventDefault();
          }}
        >
          <span aria-hidden="true" />
        </div>
        <button
          className="pane-toggle"
          aria-pressed={!graphOpen}
          aria-label={graphOpen ? 'Hide the decision graph' : 'Show the decision graph'}
          title={graphOpen ? 'Hide the decision graph' : 'Show the decision graph'}
          onClick={() => setView(graphOpen ? 'chat' : 'split')}
        >
          <Icon name={graphOpen ? 'chevronRight' : 'chevronLeft'} size={14} />
          <span className="sr-only">Decision graph</span>
        </button>
      </div>
      <div className="route-map-region" aria-hidden={!graphOpen} inert={!graphOpen || undefined}>
        {trace.nodes.length ? (
          <DecisionCanvas trace={trace} selected={selected} onSelect={onSelect} paused={paused} />
        ) : (
          <div className="graph-skeleton">
            <Icon name="graph" size={30} />
            <span>Waiting for the first recorded step</span>
            <small>Planned nodes appear here as soon as a workflow is prepared.</small>
          </div>
        )}
      </div>
      {open && graphOpen && (
        <RunInspector
          trace={trace}
          selected={selected!}
          onDeselect={onDeselect}
          override={override}
          onOverride={onOverride}
        />
      )}
      {metrics}
    </div>
  );
}

export function Workspace() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { providers, openConnection } = useHarness();
  const [scenario, setScenario] = useState<Scenario>(
    params.get('example') === 'trip' ? 'trip' : 'support',
  );
  const [started, setStarted] = useState(!params.has('new'));
  const [elapsed, setElapsed] = useState(3200);
  const [playing, setPlaying] = useState(true);
  const [approval, setApproval] = useState<'approved' | 'rejected'>();
  const [selected, setSelected] = useState<string>();
  const [mode, setMode] = useState<'preview' | 'backend'>('preview');
  const [prompt, setPrompt] = useState(SCENARIOS[scenario].prompt);
  const [customPreview, setCustomPreview] = useState(false);
  const [overrides, setOverrides] = useState<RouteOverrides>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [prepared, setPrepared] = useState<AgentGraph | null>(null);
  const [pastMessages, setPastMessages] = useState<string[]>([]);
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const active = mode === 'preview' && started && playing && elapsed < PREVIEW_LIMIT;

  useEffect(() => {
    if (!active) return;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      setElapsed((value) => advancePreview(value, now - previous, true, PREVIEW_LIMIT));
      previous = now;
    }, 160);
    return () => window.clearInterval(timer);
  }, [active]);

  const trace = useMemo(
    (): Trace =>
      mode === 'preview' && started
        ? previewTrace(scenario, elapsed, approval, overrides)
        : {
            ...buildTrace(emptyRunView, prepared),
            provenance: mode === 'preview' ? 'preview' : 'unknown',
            status: busy ? 'pending' : 'ready',
          },
    [mode, started, scenario, elapsed, approval, overrides, prepared, busy],
  );
  const done = trace.status === 'succeeded';
  const gate = trace.status === 'awaiting_approval';
  const sample = SCENARIOS[scenario];

  const scrollCheckpoint = useRef('false:false::0');
  useEffect(() => {
    const checkpoint = `${gate}:${done}:${busy}:${pastMessages.length}`;
    if (scrollCheckpoint.current === checkpoint) return;
    scrollCheckpoint.current = checkpoint;
    if (atBottom.current)
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'auto' });
  }, [gate, done, busy, pastMessages.length]);

  const replay = (next = scenario) => {
    setScenario(next);
    setPrompt(SCENARIOS[next].prompt);
    setElapsed(0);
    setPlaying(true);
    setApproval(undefined);
    setSelected(undefined);
    setStarted(true);
    setCustomPreview(false);
    setOverrides({});
    setMode('preview');
    setError('');
    setPrepared(null);
  };

  // Editing a route in preview re-runs the workflow with the new choice, from the top, so
  // the consequence of the edit is actually visible rather than asserted.
  const applyOverride = (nodeId: string, route: RouteOption) => {
    setOverrides((current) => ({ ...current, [nodeId]: route }));
    setElapsed(0);
    setApproval(undefined);
    setPlaying(true);
  };

  const send = async (text: string) => {
    setError('');
    if (mode === 'preview') {
      if (started) setPastMessages((items) => [...items, prompt]);
      setPrompt(text);
      setCustomPreview(true);
      setStarted(true);
      setElapsed(0);
      setPlaying(true);
      setApproval(undefined);
      setSelected(undefined);
      setOverrides({});
      return true;
    }
    if (!providers.some((provider) => provider.id === 'hermes' && provider.healthy)) {
      setError(
        'Connect the configured Hermes adapter before starting a backend run. Your message has been kept.',
      );
      openConnection();
      return false;
    }
    setStarted(true);
    setPrompt(text);
    setPrepared(null);
    setBusy('Preparing the workflow');
    try {
      const { conversation } = await api.createConversation();
      const result = await api.sendMessage(conversation.id, text);
      setPrepared(result.graph);
      setBusy('Starting execution');
      const { run } = await api.runGraph(result.graph.id);
      navigate('/runs/' + run.id, {
        state: { conversation: result.conversation, graph: result.graph },
      });
      return true;
    } catch (issue) {
      setError(
        issue instanceof Error
          ? issue.message
          : 'Could not start the task. Check the API and try again.',
      );
      return false;
    } finally {
      setBusy('');
    }
  };

  const lane = (
    <>
      {!started ? (
        <EmptyWorkspace onExample={replay} />
      ) : (
        <>
          <header className="conversation-heading">
            <div>
              <h1>
                {mode === 'backend'
                  ? 'Your next task'
                  : customPreview
                    ? 'Exploring a workflow'
                    : sample.title}
              </h1>
              <p>
                {mode === 'preview'
                  ? 'Interactive preview · synthetic data'
                  : 'Connected to your Zephyr backend'}
              </p>
            </div>
            {mode === 'preview' && (
              <button
                className="icon-button"
                aria-label="Restart preview"
                title="Restart preview"
                onClick={() => replay()}
              >
                <Icon name="replay" size={17} />
              </button>
            )}
          </header>
          {pastMessages.map((text, index) => (
            <details className="previous-exchange" key={index}>
              <summary>Earlier preview · {text}</summary>
              <p>This earlier example was simulated. No task was sent to a model or tool.</p>
            </details>
          ))}
          <Message author="you">
            <p className="user-request">{prompt}</p>
          </Message>
          <Message author="agent">
            <p className="assistant-intro">
              {mode === 'preview'
                ? customPreview
                  ? 'I can show you how this workspace behaves. This is the sample workflow, not a generated answer to your message. Switch to the backend to execute your own task.'
                  : sample.intro
                : busy
                  ? 'Turning your request into a workflow. Execution will start as soon as it is ready.'
                  : prepared
                    ? 'The workflow is prepared. Execution has not started.'
                    : 'Your task will run through the configured backend.'}
            </p>
            {mode === 'preview' && trace.nodes.length > 0 && (
              <div className="routing-summary">
                <span>
                  <Icon name="graph" size={14} />
                  {scenario === 'support'
                    ? 'Private context + public research'
                    : 'Three research branches'}
                </span>
                <span>
                  <Icon name="shield" size={14} />
                  {scenario === 'support' ? 'Approval before outreach' : 'No purchases or bookings'}
                </span>
              </div>
            )}
            {busy && (
              <WorkingStatus>
                {busy}
                <span className="ellipsis">…</span>
              </WorkingStatus>
            )}
            {mode === 'preview' && trace.status === 'running' && (
              <WorkingStatus active={playing}>
                {playing
                  ? trace.nodes.filter((node) => node.status === 'running').length > 1
                    ? 'Working on parallel tasks'
                    : (trace.nodes.find((node) => node.status === 'running')?.label ??
                      'Preparing the next step')
                  : 'Workflow paused — resume when you’re ready'}
                {playing && <span className="ellipsis">…</span>}
              </WorkingStatus>
            )}
            {mode === 'preview' && elapsed >= 16500 && (
              <div className="assistant-result">
                <h2>
                  {scenario === 'support'
                    ? 'A brief you can act on.'
                    : 'Three days, without the rush.'}
                </h2>
                <p>{sample.result}</p>
                <ul>
                  {sample.notes.map((note) => (
                    <li key={note}>
                      <Icon name="check" size={14} />
                      {note}
                    </li>
                  ))}
                </ul>
                <span className="result-provenance">Illustrative output · not live research</span>
              </div>
            )}
            {gate && (
              <section className="preview-approval">
                <div>
                  <Icon name="lock" size={18} />
                  <h3>Your call from here.</h3>
                </div>
                <p>
                  Review the example outreach before continuing. This is a simulated approval;
                  nothing will be sent.
                </p>
                <details>
                  <summary>View exact example payload</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        simulated: true,
                        action: 'send_email',
                        to: 'account@example.invalid',
                        subject: 'Account review',
                        body: 'Hello, we would like to review your account needs with you.',
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <div className="approval-actions">
                  <button className="primary-button" onClick={() => setApproval('approved')}>
                    <Icon name="check" size={15} />
                    Approve preview
                  </button>
                  <button className="secondary-button" onClick={() => setApproval('rejected')}>
                    Reject
                  </button>
                </div>
              </section>
            )}
            {approval && (
              <p className={approval === 'approved' ? 'success-note' : 'notice'} role="status">
                {approval === 'approved'
                  ? 'Preview approved. No outreach was sent.'
                  : 'Preview rejected. The example workflow is stopped.'}
              </p>
            )}
          </Message>
        </>
      )}
      {error && (
        <div className="error-note" role="alert">
          {error}
          {prepared && <Link to={'/graphs/' + prepared.id}>Open the prepared workflow</Link>}
        </div>
      )}
    </>
  );

  return (
    <WorkspaceShell
      trace={trace}
      selected={selected}
      onSelect={setSelected}
      onDeselect={() => setSelected(undefined)}
      paused={!playing || gate || done}
      scrollRef={scroll}
      onLaneScroll={(event) => {
        const element = event.currentTarget;
        atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
      }}
      override={selected ? overrides[selected] : undefined}
      onOverride={mode === 'preview' ? applyOverride : undefined}
      lane={lane}
      composer={
        <TaskComposer
          mode={mode}
          busy={!!busy}
          onModeChange={(next) => {
            setMode(next);
            setError('');
            setPrepared(null);
            if (next === 'backend') setStarted(false);
          }}
          onSend={send}
        />
      }
      metrics={
        <MetricsStrip
          trace={trace}
          paused={!playing}
          onPause={mode === 'preview' ? () => setPlaying(!playing) : undefined}
          onReplay={() => replay()}
        />
      }
    />
  );
}

export function LiveRunWorkspace() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const seed = location.state as { conversation?: Conversation; graph?: AgentGraph } | null;
  const [retry, setRetry] = useState(0);
  const view = useRunStream(id, retry);
  const snapshot = useRunGraph(view.run?.input ?? null);
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const graph = snapshot ?? seed?.graph;
  const trace = useMemo(() => buildTrace(view, graph, now), [view, graph, now]);
  const terminal = !!view.run && isTerminal(view.run.status);

  useEffect(() => {
    if (terminal) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [terminal]);
  useEffect(() => {
    let ignore = false;
    setLoadError('');
    if (id)
      api.getRun(id).catch((issue) => {
        if (!ignore)
          setLoadError(issue instanceof Error ? issue.message : 'Could not load this run.');
      });
    return () => {
      ignore = true;
    };
  }, [id, retry]);

  const followUp = async (text: string) => {
    setBusy(true);
    setError('');
    try {
      const conversationId =
        seed?.conversation?.id ?? (await api.createConversation(graph?.id)).conversation.id;
      const result = await api.sendMessage(conversationId, text);
      const { run } = await api.runGraph(result.graph.id);
      navigate('/runs/' + run.id, {
        state: { conversation: result.conversation, graph: result.graph },
      });
      return true;
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Could not start your follow-up.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!id || !window.confirm('Cancel this backend run? Work already performed cannot be undone.'))
      return;
    try {
      await api.cancelRun(id);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Cancellation was not confirmed.');
    }
  };

  const lane = (
    <>
      <header className="conversation-heading">
        <div>
          <h1>{view.run?.title ?? 'Connecting to your run'}</h1>
          <p>
            Backend execution ·{' '}
            {trace.provenance === 'unknown'
              ? 'awaiting provider reports'
              : trace.provenance + ' provider activity'}
          </p>
        </div>
        <Link to="/runs" className="icon-button" title="Run history" aria-label="Run history">
          <Icon name="clock" />
        </Link>
      </header>
      {loadError ? (
        <div className="error-note" role="alert">
          <strong>This run could not be loaded.</strong>
          <p>{loadError}</p>
          <button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>
            Retry connection
          </button>
        </div>
      ) : (
        <>
          {seed?.conversation?.messages
            .filter((message) => message.role === 'user')
            .map((message) => (
              <Message author="you" key={message.id}>
                <p className="user-request">{message.text}</p>
              </Message>
            ))}
          <Message author="agent">
            <p className="assistant-intro">
              {view.run?.summary ??
                seed?.conversation?.messages.findLast((message) => message.role === 'assistant')
                  ?.text ??
                'Following the execution stream. Recorded steps and routing decisions will appear here as they arrive.'}
            </p>
            {!terminal && (
              <WorkingStatus active={view.connected && view.run?.status !== 'awaiting_approval'}>
                {view.run?.status === 'awaiting_approval'
                  ? 'Waiting for your approval'
                  : !view.connected
                    ? 'Connection interrupted — reconnecting'
                    : (trace.nodes.find((node) => node.status === 'running')?.label ??
                      'Waiting for a backend update')}
              </WorkingStatus>
            )}
            {view.approvals
              .filter((approval) => approval.status === 'pending')
              .map((approval) => (
                <ApprovalPanel key={approval.id} approval={approval} />
              ))}
            {view.run?.error && (
              <p className="error-note" role="alert">
                {view.run.error.message}
              </p>
            )}
            {view.logs.length > 0 && (
              <details className="run-details">
                <summary>
                  Activity log <span>{view.logs.length} events</span>
                </summary>
                <ul className="event-log">
                  {view.logs.map((log, index) => (
                    <li key={index}>
                      <time>{log.at.slice(11, 19)}</time>
                      <span>{log.message}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {view.egress.length > 0 && (
              <details className="run-details">
                <summary>
                  Data & provider activity <span>{view.egress.length} records</span>
                </summary>
                <EgressLedger events={view.egress} piiSpans={view.piiSpans} />
              </details>
            )}
            {graph && (
              <Link className="text-link" to={'/graphs/' + graph.id}>
                Open workflow editor <Icon name="arrow" size={14} />
              </Link>
            )}
            {terminal && (
              <div className="completion-line">
                <Icon name={trace.status === 'succeeded' ? 'check' : 'stop'} size={17} />
                {trace.status === 'succeeded'
                  ? 'Run complete'
                  : trace.status === 'cancelled'
                    ? 'Run cancelled'
                    : 'Run failed'}
                <span>Execution events retained for inspection</span>
              </div>
            )}
          </Message>
        </>
      )}
      {error && (
        <p role="alert" className="error-note">
          {error}
        </p>
      )}
    </>
  );

  return (
    <WorkspaceShell
      trace={trace}
      selected={selected}
      onSelect={setSelected}
      onDeselect={() => setSelected(undefined)}
      paused={!view.connected || terminal}
      lane={lane}
      composer={
        <TaskComposer
          mode="backend"
          onSend={followUp}
          busy={busy}
          disabled={!terminal}
          placeholder={
            terminal ? 'Refine this workflow or ask a follow-up…' : 'Your workflow is running…'
          }
          hint={
            terminal
              ? 'A follow-up edits this workflow and starts a new run.'
              : 'Follow-ups unlock when this run finishes. Use the approval or cancel controls to intervene.'
          }
        />
      }
      metrics={
        <MetricsStrip
          trace={trace}
          onCancel={() => void cancel()}
          connected={view.connected}
          lastEventAt={view.lastEventAt}
        />
      }
    />
  );
}
