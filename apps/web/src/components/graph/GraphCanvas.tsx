/**
 * The graph canvas.
 *
 * Read-only by default (the run view, `RunDetail.tsx`, never passes
 * `editable`). `GraphEditor.tsx` passes `editable`, which turns on drag,
 * connect, and delete -- the node renderer, palette and live overlay do not
 * change between the two modes, which is why they were split out ahead of
 * this rather than written inline.
 *
 * Node positions are kept in local state, resynced from `graph` whenever the
 * document identity changes (a save, a chat edit, a different graph loaded).
 * Dragging only ever touches that local copy; a drag's own `onNodeDragStop`
 * is what pushes the new position back to the server, and the resync that
 * follows the server's response confirms it rather than causing a jump --
 * two sources of truth would otherwise fight over the same coordinate on
 * every render.
 *
 * `steps` and `analytics` are optional: with neither, this renders a static
 * document (the editor). With them, the same component is the live run view.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnect,
  type OnEdgesDelete,
  type OnNodesDelete,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Crosshair } from 'lucide-react';
import {
  executorOf,
  type AgentGraph,
  type RunAnalytics,
  type Step,
  type StepStatus,
} from '@htn/shared';
import { FlowEdge, type FlowEdgeData } from './FlowEdge';
import { NodeCard, type NodeCardData } from './NodeCard';
import { EXECUTOR_CLASSES } from './palette';

const NODE_TYPES = { agentNode: NodeCard };
const EDGE_TYPES = { flow: FlowEdge };
const DELETE_KEYS = ['Backspace', 'Delete'];

/**
 * Worst-wins, matching rollup()'s node status. A swarm whose parent succeeded
 * but which had a failed worker should read as failed on the canvas too.
 */
const RANK: Record<StepStatus, number> = {
  failed: 5,
  blocked: 4,
  running: 3,
  pending: 2,
  succeeded: 1,
  skipped: 0,
};

export function statusByNode(steps: Step[]): Map<string, StepStatus> {
  const out = new Map<string, StepStatus>();
  for (const step of steps) {
    if (!step.nodeId) continue;
    const current = out.get(step.nodeId);
    if (!current || RANK[step.status] > RANK[current]) out.set(step.nodeId, step.status);
  }
  return out;
}

/**
 * Pans the camera to whichever node is working right now, so a long graph
 * never runs off-screen during a live run. Lives inside <ReactFlow> because it
 * needs the flow instance. `blocked` outranks `running`: a run waiting on a
 * person is the one place the viewer must be looking.
 */
function FollowActive({
  statuses,
  enabled,
}: {
  statuses: Map<string, StepStatus>;
  enabled: boolean;
}) {
  const { fitView } = useReactFlow();

  let activeId: string | undefined;
  for (const [id, status] of statuses) {
    if (status === 'blocked') {
      activeId = id;
      break;
    }
    if (status === 'running' && !activeId) activeId = id;
  }

  useEffect(() => {
    if (!enabled || !activeId) return;
    void fitView({ nodes: [{ id: activeId }], duration: 600, padding: 0.8, maxZoom: 1.05 });
  }, [activeId, enabled, fitView]);

  return null;
}

/** Re-fits the whole graph whenever `signal` changes (e.g. after auto-layout). */
function FitOnSignal({ signal }: { signal?: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (signal === undefined || signal === 0) return;
    // Deferred: the canvas copies new node positions in its own effect, which
    // runs after this child's. Fitting immediately would frame the OLD layout.
    const timer = setTimeout(() => void fitView({ duration: 500, padding: 0.2 }), 120);
    return () => clearTimeout(timer);
  }, [signal, fitView]);
  return null;
}

export interface GraphCanvasProps {
  graph: AgentGraph;
  /** Live steps from useRunStream. Omit for a static document view. */
  steps?: Step[];
  /** Per-node metrics, normally computed client-side with rollup(). */
  analytics?: RunAnalytics | null;
  selectedNodeId?: string;
  onSelectNode?: (nodeId: string) => void;
  className?: string;
  /** Turns on drag, connect, and delete. Only the editor page sets this. */
  editable?: boolean;
  /** Fired once a drag ends -- not on every intermediate mouse move. */
  onMoveNode?: (nodeId: string, position: { x: number; y: number }) => void;
  onConnectNodes?: (source: string, target: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  onDeleteEdge?: (edgeId: string) => void;
  /** Bump to re-fit the whole graph into view (animated). */
  fitSignal?: number;
}

export function GraphCanvas({
  graph,
  steps,
  analytics,
  selectedNodeId,
  onSelectNode,
  className = 'h-[520px]',
  editable = false,
  onMoveNode,
  onConnectNodes,
  onDeleteNode,
  onDeleteEdge,
  fitSignal,
}: GraphCanvasProps) {
  // Keyed on the statuses' CONTENT, not on the `steps` array: a caller (the run
  // replay) may hand over a fresh array every frame. A new map identity would
  // rebuild every node below, and React Flow hides a node until it has been
  // re-measured -- so the canvas would flicker blank instead of animating.
  const computed = statusByNode(steps ?? []);
  const statusSignature = [...computed]
    .map(([id, status]) => id + ':' + status)
    .sort()
    .join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const statuses = useMemo(() => computed, [statusSignature]);

  // Live only when there are steps still in flight; a finished run (or the
  // editor) never moves the camera on its own.
  const live = useMemo(
    () => (steps ?? []).some((s) => s.status === 'running' || s.status === 'blocked'),
    [steps],
  );
  const [follow, setFollow] = useState(true);

  const metricsByNode = useMemo(() => {
    const map = new Map<string, RunAnalytics['nodes'][number]>();
    for (const node of analytics?.nodes ?? []) map.set(node.nodeId, node);
    return map;
  }, [analytics]);

  const buildNodes = useCallback(
    (): Node<NodeCardData>[] =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: 'agentNode',
        position: node.position,
        draggable: editable,
        connectable: editable,
        data: {
          node,
          status: statuses.get(node.id),
          metrics: metricsByNode.get(node.id),
          selected: selectedNodeId === node.id,
          onOpen: onSelectNode,
          editable,
          onDelete: onDeleteNode,
        },
      })),
    [graph.nodes, statuses, metricsByNode, selectedNodeId, onSelectNode, editable, onDeleteNode],
  );

  // Local copy so a drag feels instant. Resynced whenever the graph document
  // itself changes underneath us (a save response, a chat edit landing, or a
  // different graph loading) -- see the file header for why this doesn't
  // fight an in-progress drag.
  const [rfNodes, setRfNodes] = useState<Node<NodeCardData>[]>(buildNodes);
  useEffect(() => {
    setRfNodes(buildNodes());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, statuses, metricsByNode, selectedNodeId, editable]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<NodeCardData>>[]) => {
      // Node removal goes through the explicit delete affordance only (see
      // NodeCard's "x") so it can be routed through the server's cascading
      // removeNode -- never let a stray keyboard gesture silently drop a node
      // from the canvas without also asking the server to drop its edges.
      const filtered = editable ? changes.filter((change) => change.type !== 'remove') : [];
      if (filtered.length > 0) setRfNodes((current) => applyNodeChanges(filtered, current));
    },
    [editable],
  );

  const handleNodeDragStop = useCallback(
    (_event: unknown, node: Node<NodeCardData>) => {
      onMoveNode?.(node.id, node.position);
    },
    [onMoveNode],
  );

  const handleConnect: OnConnect = useCallback(
    (connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) {
        return;
      }
      onConnectNodes?.(connection.source, connection.target);
    },
    [onConnectNodes],
  );

  const handleNodesDelete: OnNodesDelete<Node<NodeCardData>> = useCallback(
    (deleted) => {
      for (const node of deleted) onDeleteNode?.(node.id);
    },
    [onDeleteNode],
  );

  const handleEdgesDelete: OnEdgesDelete<Edge> = useCallback(
    (deleted) => {
      for (const edge of deleted) onDeleteEdge?.(edge.id);
    },
    [onDeleteEdge],
  );

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((edge) => {
        const targetStatus = statuses.get(edge.target);
        const sourceStatus = statuses.get(edge.source);
        // An edge animates only while the work it feeds is actually happening,
        // so motion on the canvas always means something is running right now.
        const active = targetStatus === 'running' || targetStatus === 'blocked';
        const traversed = sourceStatus === 'succeeded' && targetStatus !== undefined;
        const source = graph.nodes.find((n) => n.id === edge.source);

        const color = source ? EXECUTOR_CLASSES[executorOf(source.type)].stroke : '#6ea8fe';

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'flow',
          data: { active, color } satisfies FlowEdgeData,
          deletable: editable,
          // A branch edge is labelled with the option that selects it, so a
          // judge's two outgoing paths are self-explaining.
          label: edge.sourceHandle,
          labelStyle: { fill: '#94a3b8', fontSize: 10 },
          labelBgStyle: { fill: '#0b0d12' },
          style: {
            stroke: traversed
              ? source
                ? EXECUTOR_CLASSES[executorOf(source.type)].stroke
                : '#475569'
              : '#334155',
            strokeWidth: active ? 2 : 1.5,
            // A branch that was never taken stays faint rather than vanishing,
            // so you can see the path the run did NOT go down.
            opacity: steps && steps.length > 0 && !traversed && !active ? 0.35 : 1,
          },
        };
      }),
    [graph.edges, graph.nodes, statuses, steps, editable],
  );

  return (
    <div className={'w-full overflow-hidden rounded-xl border border-slate-800 ' + className}>
      <ReactFlow
        nodes={rfNodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        // A person grabbing the canvas means "let me look around" -- stop
        // chasing the active node until they turn following back on.
        onMoveStart={(event) => {
          if (event) setFollow(false);
        }}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        // Default minZoom is 0.5, which can't fit a tall graph (auto-layout
        // stacks a long pipeline vertically) into a 400-500px canvas.
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={editable}
        nodesDraggable={editable}
        elementsSelectable={editable}
        deleteKeyCode={editable ? DELETE_KEYS : null}
        onNodesChange={handleNodesChange}
        onNodeDragStop={handleNodeDragStop}
        onConnect={handleConnect}
        onNodesDelete={handleNodesDelete}
        onEdgesDelete={handleEdgesDelete}
        onNodeClick={(_event, node) => onSelectNode?.(node.id)}
        className="bg-slate-950"
      >
        <Background color="#1f2635" gap={18} size={1.2} />
        <FitOnSignal signal={fitSignal} />
        {live && <FollowActive statuses={statuses} enabled={follow} />}
        {live && (
          <Panel position="top-right">
            <button
              type="button"
              onClick={() => setFollow((v) => !v)}
              aria-pressed={follow}
              title="Keep the camera on the node that is running"
              className={
                'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ' +
                (follow
                  ? 'border-sky-500/50 bg-sky-500/15 text-sky-300'
                  : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200')
              }
            >
              <Crosshair className="h-3 w-3" />
              Follow
            </button>
          </Panel>
        )}
        <Controls
          showInteractive={false}
          className="!bottom-2 !left-2 [&>button]:!border-slate-700 [&>button]:!bg-slate-800 [&>button]:!fill-slate-300"
        />
        <MiniMap
          pannable
          zoomable
          className="!bottom-2 !right-2 !bg-slate-900"
          maskColor="rgba(11,13,18,0.7)"
          nodeColor={(node) => {
            const data = node.data as NodeCardData;
            return EXECUTOR_CLASSES[executorOf(data.node.type)].stroke;
          }}
        />
      </ReactFlow>
    </div>
  );
}
