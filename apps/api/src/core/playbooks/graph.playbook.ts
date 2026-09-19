/**
 * The graph playbook — the one playbook that is not about any subject matter.
 *
 * Everything product-specific now lives in a GRAPH DOCUMENT rather than in a
 * file like demo.playbook.ts. This playbook just loads the document and hands
 * it to the interpreter, which is why adding a node type never touches this
 * file and never touches the orchestrator.
 *
 * demo.playbook.ts stays registered alongside it on purpose: it is the fallback
 * run that works even if graph execution breaks.
 */

import { graphRunInputSchema, type AgentGraph, type GraphRunInput } from '@htn/shared';
import { runGraph } from '../graph/interpreter.js';
import { store } from '../../store/index.js';
import { definePlaybook } from './types.js';

export const graphPlaybook = definePlaybook<GraphRunInput>({
  kind: 'graph',
  title: 'Run an agent graph',
  inputSchema: graphRunInputSchema,

  async execute(ctx, input) {
    // Prefer the snapshot taken at creation time. Falling back to a live load
    // keeps a run launched by an older client working, but the snapshot is what
    // guarantees an old run page still shows the graph it actually executed.
    let graph: AgentGraph | null = input.graphSnapshot ?? null;

    if (!graph) {
      graph = await store.getGraph(input.graphId);
      if (!graph) throw new Error('No graph found with id "' + input.graphId + '"');
    }

    await ctx.log(
      'info',
      'Executing graph "' +
        graph.name +
        '" v' +
        graph.version +
        ' (' +
        graph.nodes.length +
        ' nodes).',
    );

    return runGraph(ctx, graph, { variables: input.variables as Record<never, never> });
  },
});
