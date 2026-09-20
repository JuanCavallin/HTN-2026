/**
 * Top-to-bottom layered layout for a graph, via ELK.
 *
 * Loaded on demand: elkjs is ~1MB and only the "Auto-layout" button needs it,
 * so it must not sit in the main bundle. dagre would be lighter but is no
 * longer maintained; ELK also handles a swarm's fan-out / fan-in cleanly.
 */

import type { AgentGraph } from '@htn/shared';

/** Matches NodeCard's `w-56`; height is the typical card with a metrics row. */
const NODE_WIDTH = 224;
const NODE_HEIGHT = 104;

export async function computeLayout(
  graph: AgentGraph,
): Promise<Map<string, { x: number; y: number }>> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();

  const ids = new Set(graph.nodes.map((node) => node.id));
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '48',
      'elk.layered.spacing.nodeNodeBetweenLayers': '72',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: graph.edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });

  const positions = new Map<string, { x: number; y: number }>();
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: Math.round(child.x ?? 0), y: Math.round(child.y ?? 0) });
  }
  return positions;
}
