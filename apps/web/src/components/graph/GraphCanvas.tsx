/**
 * The graph canvas.
 *
 * Read-only for now (Phase 2). Editing is Phase 4 and will add drag/connect on
 * top of this same component -- the node renderer, the palette and the live
 * overlay do not change when it becomes editable, which is why they are split
 * out rather than written inline here.
 *
 * `steps` and `analytics` are optional: with neither, this renders a static
 * document (the editor). With them, the same component is the live run view.
 */

import { useMemo } from 'react';
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  executorOf,
  type AgentGraph,
  type RunAnalytics,
  type Step,
  type StepStatus,
} from '@htn/shared';
import { NodeCard, type NodeCardData } from './NodeCard';
import { EXECUTOR_CLASSES } from './palette';

const NODE_TYPES = { agentNode: NodeCard };

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

function statusByNode(steps: Step[]): Map<string, StepStatus> {
  const out = new Map<string, StepStatus>();
  for (const step of steps) {
    if (!step.nodeId) continue;
    const current = out.get(step.nodeId);
    if (!current || RANK[step.status] > RANK[current]) out.set(step.nodeId, step.status);
  }
  return out;
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
}

export function GraphCanvas({
  graph,
  steps,
  analytics,
  selectedNodeId,
  onSelectNode,
  className = 'h-[520px]',
}: GraphCanvasProps) {
  const statuses = useMemo(() => statusByNode(steps ?? []), [steps]);

  const metricsByNode = useMemo(() => {
    const map = new Map<string, RunAnalytics['nodes'][number]>();
    for (const node of analytics?.nodes ?? []) map.set(node.nodeId, node);
    return map;
  }, [analytics]);

  const nodes: Node<NodeCardData>[] = useMemo(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: 'agentNode',
        position: node.position,
        draggable: false,
        data: {
          node,
          status: statuses.get(node.id),
          metrics: metricsByNode.get(node.id),
          selected: selectedNodeId === node.id,
          onOpen: onSelectNode,
        },
      })),
    [graph.nodes, statuses, metricsByNode, selectedNodeId, onSelectNode],
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

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          animated: active,
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
    [graph.edges, graph.nodes, statuses, steps],
  );

  return (
    <div className={'w-full overflow-hidden rounded-lg border border-slate-800 ' + className}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        nodesDraggable={false}
        onNodeClick={(_event, node) => onSelectNode?.(node.id)}
        className="bg-slate-950"
      >
        <Background color="#1e293b" gap={16} />
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
