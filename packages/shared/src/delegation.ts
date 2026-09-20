/**
 * How much of the work a graph LEAVES for runtime to decide.
 *
 * ============================================================================
 * THE FAILURE THIS EXISTS TO CATCH
 *
 * A synthesiser that emits a fully-specified graph -- every tool pinned, every
 * argument literal -- produces something that runs, looks impressive, and has
 * quietly demoted the two components the product is about:
 *
 *   the decision layer has nothing left to route (the tool is already chosen)
 *   the agent harness has nothing left to plan (the steps are already drawn)
 *
 * That graph does not "use Jev and Hermes". It replaces them, and the
 * availableTools-vs-exposedTools headline collapses to 1-of-1.
 *
 * So the division of labour is deliberate, and this file measures it:
 *
 *   SYNTHESIS decides STRUCTURE  -- what stages exist, their order, where the
 *                                   gates go
 *   the DECISION layer decides WHICH -- which tool, which tier, at runtime,
 *                                   per subtask
 *   the HARNESS decides HOW      -- its own loop, for a goal nobody decomposed
 *
 * A `tool` node is not bad -- deterministic plumbing should be pinned, and it
 * costs nothing. A graph made ENTIRELY of `tool` nodes is the warning sign.
 * ============================================================================
 */

import type { AgentGraph } from './schemas/graph.js';

export interface GraphDelegation {
  /** Tool calls fixed at authoring time: `tool` and `submit` nodes. */
  pinnedCalls: number;
  /** Tool choices handed to the decision layer at runtime: `dispatch` nodes. */
  deferredToolChoices: number;
  /**
   * Candidates the decision layer gets to narrow, summed across `dispatch` and
   * `agent_task`. This is the raw material for the availableTools-vs-exposed
   * number; if it is zero, that metric has nothing to report.
   */
  candidateTools: number;
  /** Subtasks handed to an agent harness to plan and run itself. */
  agentSubtasks: number;
  /**
   * Of the nodes that end in a tool call, the share whose tool is chosen at
   * RUNTIME rather than at authoring time. 0 means everything was pinned.
   */
  runtimeShare: number;
  /**
   * Nothing was left for the decision layer or a harness. The graph is a
   * script, not an agent pipeline -- worth surfacing in the UI and worth
   * rejecting from a synthesiser.
   */
  fullyPinned: boolean;
}

export function delegationOf(graph: Pick<AgentGraph, 'nodes'>): GraphDelegation {
  let pinnedCalls = 0;
  let deferredToolChoices = 0;
  let candidateTools = 0;
  let agentSubtasks = 0;

  for (const node of graph.nodes) {
    switch (node.type) {
      case 'tool':
      case 'submit':
        pinnedCalls += 1;
        break;
      case 'dispatch':
        deferredToolChoices += 1;
        candidateTools += node.config.candidateTools.length;
        break;
      case 'agent_task':
        agentSubtasks += 1;
        candidateTools += node.config.availableTools.length;
        break;
      default:
        break;
    }
  }

  const toolNodes = pinnedCalls + deferredToolChoices;

  return {
    pinnedCalls,
    deferredToolChoices,
    candidateTools,
    agentSubtasks,
    runtimeShare: toolNodes > 0 ? deferredToolChoices / toolNodes : 0,
    fullyPinned: deferredToolChoices === 0 && agentSubtasks === 0,
  };
}

/**
 * Is this graph shaped so the decision layer and the harness still have work?
 *
 * Used to reject a synthesised graph before it is saved. Deliberately lenient:
 * ONE deferred decision anywhere is enough. The aim is to catch the degenerate
 * "model wrote a shell script" output, not to impose a style on a human author
 * who has good reason to pin everything.
 */
export function hasRuntimeDelegation(graph: Pick<AgentGraph, 'nodes'>): boolean {
  return !delegationOf(graph).fullyPinned;
}
