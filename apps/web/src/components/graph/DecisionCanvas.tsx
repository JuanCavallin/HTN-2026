import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeProps,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Icon, type IconName } from '../ui/Icon';
import {
  formatDuration,
  formatTokens,
  toolActivity,
  toolGlyph,
  type Trace,
  type TraceNode,
} from '../../lib/workspace';

const kindIcons: Record<string, IconName> = {
  judge: 'graph',
  redact: 'shield',
  browse: 'globe',
  fetch: 'file',
  decide: 'search',
  approval: 'lock',
  result: 'check',
  submit: 'send',
  tool: 'settings',
  tool_call: 'connect',
  tool_exposed: 'connect',
  swarm: 'spark',
  agent_task: 'activity',
};

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type DecisionData = Record<string, unknown> & {
  item: TraceNode;
  selected: boolean;
  onSelect: (id: string) => void;
  paused: boolean;
  onPath: boolean;
  junction: boolean;
};

function DecisionNode({ data }: NodeProps<Node<DecisionData>>) {
  const { item, onSelect, selected, paused, onPath, junction } = data;
  const active = item.status === 'running';
  const classes = [
    'decision-node',
    item.status,
    item.planned ? 'is-planned' : 'is-materialized',
    item.unplanned ? 'is-unplanned' : '',
    item.role ? 'is-tool ' + item.role : '',
    item.revised ? 'is-revised' : '',
    selected ? 'selected' : '',
    paused ? 'motion-paused' : '',
    onPath ? 'on-path' : 'off-path',
  ]
    .filter(Boolean)
    .join(' ');
  const state = active
    ? paused
      ? 'Paused'
      : 'Working'
    : item.status === 'succeeded'
      ? 'Complete'
      : item.status === 'blocked'
        ? 'Needs approval'
        : item.status === 'pending'
          ? 'Planned'
          : item.status;
  // A tool says where it runs and what that provider is doing right now.
  const activity = toolActivity(item);
  return (
    <div className={classes}>
      <Handle type="target" position={Position.Left} />
      {junction && <span className="node-junction" aria-hidden="true" />}
      <button
        className="node-action"
        onClick={() => onSelect(item.id)}
        aria-label={`${item.label}, ${
          item.role === 'tool-exposed' ? 'tool offered, not called' : item.status
        }${item.tool ? ', ' + (activity ?? '') : ''}${item.planned && !item.role ? ', planned' : ''}${
          item.unplanned ? ', created at runtime' : ''
        }. Inspect ${item.tool ? 'tool' : 'decision'}`}
        aria-pressed={selected}
      >
        <span className="node-heading">
          {item.tool ? (
            <i className="node-glyph" aria-hidden="true">
              {toolGlyph(item.tool)}
            </i>
          ) : (
            <Icon name={kindIcons[item.kind] ?? 'spark'} size={16} />
          )}
          <span>{item.label}</span>
          <span className="node-status">
            {item.status === 'succeeded' ? (
              <Icon name="check" size={14} />
            ) : item.status === 'blocked' ? (
              <Icon name="pause" size={13} />
            ) : active ? (
              <span className="working-dot" />
            ) : null}
          </span>
        </span>
        <span className="node-description">{item.route}</span>
        <span className="node-measure">
          <span className={item.tool ? 'node-activity' : undefined}>{activity ?? state}</span>
          <span className="node-measure-values">
            {/* A tool call reports no tokens of its own, so it never shows a token count. */}
            {!item.tool && (
              <span
                className="node-tokens"
                title={
                  item.tokens === undefined
                    ? 'No token usage reported for this step'
                    : `${item.tokens.toLocaleString()} tokens`
                }
              >
                <Icon name="tokens" size={11} />
                {formatTokens(item.tokens)}
              </span>
            )}
            {item.role !== 'tool-exposed' && (
              <span title="Duration">{formatDuration(item.durationMs)}</span>
            )}
          </span>
        </span>
      </button>
      {item.unplanned && <span className="node-flag">Runtime</span>}
      {item.revised && <span className="node-flag revised">Edited</span>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const NODE_TYPES = { decision: DecisionNode };

/**
 * Every fit uses these bounds. `maxZoom` stops a two-node graph from filling the viewport
 * at absurd scale, and `minZoom` stops a long run from shrinking its labels past reading.
 */
const FIT = { padding: 0.14, minZoom: 0.45, maxZoom: 1.2 } as const;
/**
 * Showing every node beats keeping labels large: a clipped graph hides work that happened.
 * A narrow pane therefore gets a lower floor rather than cropping the ranks off the edge.
 */
const fitOptions = () => ({
  ...FIT,
  minZoom: typeof window !== 'undefined' && window.innerWidth < 900 ? 0.22 : FIT.minZoom,
  duration: reducedMotion() ? 0 : 320,
});

function CanvasControls({ signature }: { signature: string }) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const [follow, setFollow] = useState(true);
  const refit = useCallback(() => void fitView(fitOptions()), [fitView]);

  useEffect(() => {
    if (!follow) return;
    // The graph grows. Easing the viewport is the difference between "a node arrived" and
    // "the picture jumped"; under reduced motion we snap instead.
    refit();
  }, [signature, follow, refit]);

  // Entering or leaving fullscreen, and collapsing either pane, both change the space the
  // graph has. Re-fit so the whole graph is readable at the new size without being asked.
  useEffect(() => {
    const onResize = () => {
      if (follow) refit();
    };
    const element = document.querySelector('.decision-canvas-body');
    const observer = element ? new ResizeObserver(onResize) : null;
    observer?.observe(element!);
    document.addEventListener('fullscreenchange', onResize);
    return () => {
      observer?.disconnect();
      document.removeEventListener('fullscreenchange', onResize);
    };
  }, [follow, refit]);

  return (
    <div className="canvas-controls">
      <div className="zoom-controls">
        <button aria-label="Zoom out" onClick={() => void zoomOut()}>
          <Icon name="zoomOut" size={14} />
        </button>
        <button aria-label="Fit graph" onClick={refit}>
          <Icon name="expand" size={14} />
        </button>
        <button aria-label="Zoom in" onClick={() => void zoomIn()}>
          <Icon name="zoomIn" size={14} />
        </button>
      </div>
      <button
        className={follow ? 'follow active' : 'follow'}
        aria-pressed={follow}
        onClick={() => setFollow(!follow)}
      >
        <span className="status-dot" /> Follow new nodes
      </button>
    </div>
  );
}

/** Root -> current path. Everything off it is dimmed, which is the route map's whole thesis. */
function activePath(trace: Trace) {
  const live = trace.nodes.filter((node) => node.status === 'running' || node.status === 'blocked');
  // Nothing is "current" once the run has stopped. Dimming everything but the last node then
  // makes a finished trace -- the thing people open to READ -- the least legible state of all,
  // and with no authored edges there is no path to walk back along anyway. Light what ran.
  if (!live.length && trace.status !== 'running' && trace.status !== 'pending')
    return new Set(trace.nodes.filter((node) => !node.planned).map((node) => node.id));
  const heads = live.length ? live : trace.nodes.filter((node) => !node.planned).slice(-1);
  const onPath = new Set(heads.map((node) => node.id));
  for (let pass = 0; pass < trace.nodes.length; pass++) {
    let grew = false;
    for (const edge of trace.edges) {
      const source = trace.nodes.find((node) => node.id === edge.source);
      if (onPath.has(edge.target) && !onPath.has(edge.source) && source && !source.planned) {
        onPath.add(edge.source);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return onPath;
}

export function DecisionCanvas({
  trace,
  selected,
  onSelect,
  paused = false,
}: {
  trace: Trace;
  selected?: string;
  onSelect: (id: string) => void;
  paused?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<'graph' | 'activity'>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches
      ? 'activity'
      : 'graph',
  );
  const [fullscreenError, setFullscreenError] = useState('');

  const onPath = useMemo(() => activePath(trace), [trace]);
  const degree = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of trace.edges) {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
      counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
    }
    return counts;
  }, [trace.edges]);

  const nodes = useMemo(
    () =>
      trace.nodes.map((item) => ({
        id: item.id,
        position: item.position,
        type: 'decision',
        // Node identity is the trace id and never changes when a node materializes, so
        // React Flow transitions the element instead of remounting it.
        data: {
          item,
          selected: selected === item.id,
          onSelect,
          paused,
          onPath: onPath.has(item.id),
          junction: (degree.get(item.id) ?? 0) > 2,
        },
      })),
    [trace.nodes, selected, onSelect, paused, onPath, degree],
  );

  const edges = useMemo(
    () =>
      trace.edges.map((edge) => {
        const target = trace.nodes.find((node) => node.id === edge.target);
        const source = trace.nodes.find((node) => node.id === edge.source);
        const active = target?.status === 'running' && source?.status === 'succeeded';
        const done = target?.status === 'succeeded' && source?.status === 'succeeded';
        const ghost = !!source?.planned || !!target?.planned;
        const lit = onPath.has(edge.source) && onPath.has(edge.target);
        return {
          ...edge,
          animated: active && !paused,
          type: 'smoothstep',
          pathOptions: { borderRadius: 18 },
          style: {
            stroke: done ? 'var(--edge-done)' : active ? 'var(--edge-active)' : 'var(--edge-idle)',
            strokeWidth: active ? 1.8 : done ? 1.3 : 1,
            strokeDasharray: ghost ? '3 5' : undefined,
            opacity: ghost ? 0.42 : lit ? 1 : 0.35,
          },
          labelStyle: { fill: '#b1b8b2', fontSize: 11 },
          labelBgStyle: { fill: 'var(--canvas)' },
        };
      }),
    [trace.edges, trace.nodes, paused, onPath],
  );

  // A tool that was offered but not called is neither planned work nor reported work, so it
  // is counted on its own rather than inflating either number.
  const offered = trace.nodes.filter((node) => node.role === 'tool-exposed').length;
  const planned = trace.nodes.filter((node) => node.planned && node.role !== 'tool-exposed').length;
  const materialized = trace.nodes.length - planned - offered;
  const signature = `${trace.nodes.length}:${materialized}`;

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (root.current?.requestFullscreen)
      void root.current
        .requestFullscreen()
        .catch(() =>
          setFullscreenError(
            'Fullscreen is unavailable in this browser. Use the graph zoom controls.',
          ),
        );
    else setFullscreenError('Use the graph zoom controls to explore.');
  }, []);

  return (
    <section className="execution-canvas" ref={root} aria-label="Execution graph">
      <div className="canvas-heading">
        <div className="view-tabs" role="tablist" aria-label="Execution view">
          <button role="tab" aria-selected={tab === 'graph'} onClick={() => setTab('graph')}>
            <Icon name="graph" size={15} /> Decision graph
          </button>
          <button role="tab" aria-selected={tab === 'activity'} onClick={() => setTab('activity')}>
            <Icon name="activity" size={15} /> Activity
          </button>
        </div>
        <div className="canvas-heading-end">
          <span className="canvas-count">
            <strong>{materialized}</strong> reported
            {planned > 0 && <em>· {planned} planned</em>}
            {offered > 0 && <em>· {offered} tools offered</em>}
          </span>
          <button
            className="icon-button"
            aria-label="Expand execution view"
            onClick={toggleFullscreen}
          >
            <Icon name="expand" size={15} />
          </button>
        </div>
      </div>
      {fullscreenError && <p className="inline-note">{fullscreenError}</p>}
      {tab === 'graph' ? (
        <div className="decision-canvas-body" role="tabpanel" aria-label="Decision graph">
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              fitView
              fitViewOptions={fitOptions()}
              minZoom={0.18}
              maxZoom={1.6}
              nodesDraggable={false}
              nodesConnectable={false}
              deleteKeyCode={null}
              attributionPosition="bottom-center"
              colorMode="dark"
            >
              <Background color="#1b211d" gap={26} size={0.8} />
              <CanvasControls signature={signature} />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
      ) : (
        <div className="activity-list" role="tabpanel" aria-label="Recorded activity">
          {trace.nodes.map((node) => (
            <button
              key={node.id}
              onClick={() => onSelect(node.id)}
              className={`activity-row ${node.planned ? 'is-planned' : ''}`}
            >
              <span className={`activity-symbol ${node.status}`}>
                {node.tool ? (
                  <i className="node-glyph" aria-hidden="true">
                    {toolGlyph(node.tool)}
                  </i>
                ) : (
                  <Icon
                    name={
                      node.status === 'succeeded'
                        ? 'check'
                        : node.status === 'blocked'
                          ? 'pause'
                          : 'activity'
                    }
                    size={15}
                  />
                )}
              </span>
              <span>
                <strong>{node.label}</strong>
                <small>
                  {node.route} · {toolActivity(node) ?? (node.planned ? 'planned' : node.status)}
                  {node.unplanned && ' · created at runtime'}
                </small>
              </span>
              <span className="activity-measure">
                {!node.tool && (
                  <span
                    className="node-tokens"
                    title={
                      node.tokens === undefined
                        ? 'No token usage reported for this step'
                        : `${node.tokens.toLocaleString()} tokens`
                    }
                  >
                    <Icon name="tokens" size={11} />
                    {formatTokens(node.tokens)}
                  </span>
                )}
                {node.role !== 'tool-exposed' && <time>{formatDuration(node.durationMs)}</time>}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="canvas-foot">
        <span>
          <span className="legend-mark complete" />
          Complete
        </span>
        <span>
          <span className="legend-mark running" />
          In progress
        </span>
        <span>
          <span className="legend-mark pending" />
          Planned only
        </span>
        <span>
          <span className="legend-mark runtime" />
          Runtime
        </span>
        {offered > 0 && (
          <span>
            <span className="legend-mark offered" />
            Tool offered, not called
          </span>
        )}
        <span className="canvas-hint">Select a node to inspect and edit its decision</span>
      </div>
    </section>
  );
}
