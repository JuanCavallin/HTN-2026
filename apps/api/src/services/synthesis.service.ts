/**
 * Turn a request into a graph.
 *
 * Three things about this file are deliberate:
 *
 * 1. It goes through the `text.model` CAPABILITY, never an SDK. Synthesis works
 *    in mock mode with no keys, and the same code path serves live.
 *
 * 2. It runs OUTSIDE a run, but every outbound call is still logged. The
 *    conversation id is the ledger key (conv_...), so a synthesis call appears
 *    in the egress ledger like any other -- which matters, because a graph's
 *    true cost includes the call that produced it.
 *
 * 3. It REJECTS a graph that leaves nothing for runtime to decide. A model
 *    asked for a workflow will pin every tool call unless told not to, and the
 *    result runs fine while quietly making the decision layer and the harness
 *    ornamental. See packages/shared/src/delegation.ts.
 */

import {
  agentGraphSchema,
  delegationOf,
  hasRuntimeDelegation,
  type AgentGraph,
  type GraphDelegation,
} from '@htn/shared';
import {
  buildSynthesisSystemPrompt,
  buildSynthesisUserPrompt,
} from '../core/graph/synthesisPrompt.js';
import { newId, nowIso } from '../lib/ids.js';
import { providers } from './runtime.js';

export class SynthesisError extends Error {
  readonly code = 'SYNTHESIS_FAILED';
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SynthesisError';
  }
}

export interface SynthesisResult {
  graph: AgentGraph;
  delegation: GraphDelegation;
  /** One line for the chat transcript. */
  message: string;
  attempts: number;
}

/** Models like to wrap JSON in a fence even when told not to. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? (fenced[1] as string) : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return body.trim();
  return body.slice(start, end + 1);
}

export async function synthesiseGraph(args: {
  conversationId: string;
  request: string;
  currentGraph: AgentGraph | null;
}): Promise<SynthesisResult> {
  const catalogResult = await providers.provider('toolbox').listTools({
    runId: args.conversationId,
    policyRule: 'tool-catalog-for-synthesis',
  });
  // A synthesiser with no catalog would invent tool names, and every one of
  // them would fail classification at run time. Better to say so now.
  const tools = catalogResult.ok ? catalogResult.data : [];

  const system = buildSynthesisSystemPrompt(tools);
  const model = providers.provider('text.model');

  let repairHint: string | undefined;

  // Two attempts: one to write it, one to repair it against the real error.
  // More than that and the model is usually failing at the task, not the format.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const completion = await model.complete(
      {
        system,
        prompt: buildSynthesisUserPrompt({
          request: args.request,
          currentGraph: args.currentGraph,
          repairHint,
        }),
        // Planning a workflow is the one genuinely frontier-tier task here.
        tier: 'frontier',
        maxTokens: 4096,
        json: true,
      },
      {
        runId: args.conversationId,
        policyRule: 'graph-synthesis',
      },
    );

    if (!completion.ok) {
      throw new SynthesisError('Model call failed: ' + completion.error.message);
    }

    const at = nowIso();
    let candidate: unknown;
    try {
      candidate = JSON.parse(extractJson(completion.data.text));
    } catch {
      repairHint = 'Your reply was not valid JSON. Return ONLY the JSON object.';
      continue;
    }

    const draft = {
      ...(candidate as Record<string, unknown>),
      // Identity and versioning belong to us, not to the model. Reusing the
      // current id keeps an edit an edit rather than a fork.
      id: args.currentGraph?.id ?? newId('graph'),
      version: 1,
      createdAt: args.currentGraph?.createdAt ?? at,
      updatedAt: at,
    };

    const parsed = agentGraphSchema.safeParse(draft);
    if (!parsed.success) {
      repairHint =
        'The document failed validation:\n' +
        parsed.error.issues
          .slice(0, 8)
          .map((issue) => '- ' + issue.path.join('.') + ': ' + issue.message)
          .join('\n');
      continue;
    }

    const graph = withPreservedPositions(parsed.data, args.currentGraph);

    // THE GUARD. A graph with no dispatch and no agent_task has pinned every
    // decision at authoring time -- it runs, but the decision layer has nothing
    // to route and the harness nothing to plan.
    if (!hasRuntimeDelegation(graph)) {
      repairHint =
        'Every tool call in that graph was pinned, which leaves the decision layer ' +
        'and the agent harness with nothing to do. Convert at least one step whose ' +
        'tool genuinely depends on earlier output into a `dispatch` node with two or ' +
        'more candidates, or into an `agent_task` if it is open-ended.';
      continue;
    }

    const delegation = delegationOf(graph);

    return {
      graph,
      delegation,
      message: describe(graph, delegation, args.currentGraph !== null),
      attempts: attempt,
    };
  }

  throw new SynthesisError('Could not produce a valid graph in two attempts', { repairHint });
}

/**
 * A node that survived an edit keeps its position, so a conversational tweak
 * does not scatter the canvas. Only genuinely new nodes get the model's layout.
 */
function withPreservedPositions(graph: AgentGraph, previous: AgentGraph | null): AgentGraph {
  if (!previous) return graph;
  const before = new Map(previous.nodes.map((n) => [n.id, n.position]));
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const kept = before.get(node.id);
      return kept ? { ...node, position: kept } : node;
    }),
  };
}

function describe(graph: AgentGraph, delegation: GraphDelegation, edited: boolean): string {
  const parts = [
    (edited ? 'Updated' : 'Built') + ' "' + graph.name + '": ' + graph.nodes.length + ' nodes.',
  ];

  if (delegation.deferredToolChoices > 0) {
    parts.push(
      delegation.deferredToolChoices +
        ' tool choice(s) left to the decision layer at runtime, from ' +
        delegation.candidateTools +
        ' candidates.',
    );
  }
  if (delegation.agentSubtasks > 0) {
    parts.push(delegation.agentSubtasks + ' subtask(s) delegated to the agent harness.');
  }
  if (delegation.pinnedCalls > 0) {
    parts.push(delegation.pinnedCalls + ' deterministic call(s) pinned.');
  }

  return parts.join(' ');
}
