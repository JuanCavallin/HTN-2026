/**
 * Descriptive tool-delegation telemetry, not workflow validity or quality.
 *
 * Synthesis chooses structure, dispatch defers a bounded tool choice to Jev,
 * and agent_task delegates an adaptive loop to a harness. Known recipes can
 * validly use neither. Arguments may still come from upstream results, and
 * other nodes (for example decide or judge) can use models without delegating
 * tool selection. No field here proves a workflow is model-free or cheaper.
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
   * Legacy field name: there are no dispatch or agent_task nodes. This is valid,
   * not a warning or rejection criterion, and does not imply zero model usage.
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
 * Does this graph defer any tool choices or adaptive subtasks to runtime?
 * Retained for consumers of delegation telemetry; false is not a validation error.
 */
export function hasRuntimeDelegation(graph: Pick<AgentGraph, 'nodes'>): boolean {
  return !delegationOf(graph).fullyPinned;
}
