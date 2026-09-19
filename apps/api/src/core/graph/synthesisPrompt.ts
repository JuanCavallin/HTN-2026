/**
 * The system prompt for turning a request into a graph.
 *
 * EVERYTHING HERE IS DERIVED, NOT LISTED. The node vocabulary comes from
 * GRAPH_NODE_TYPES and the tool list from the live catalog, so adding a node
 * type or connecting a new tool provider teaches the synthesiser about it with
 * no edit to this file. The moment someone pastes a literal tool array in here
 * "to make the demo work", the product stops being about the registry.
 *
 * The rules below exist to stop the synthesiser hollowing out the runtime --
 * see packages/shared/src/delegation.ts for the failure mode. A model asked to
 * "build a workflow" will happily pin every tool call, producing a graph that
 * runs fine and leaves the decision layer and the harness with nothing to do.
 */

import { GRAPH_NODE_TYPES, type AgentGraph } from '@htn/shared';

export interface ToolCatalogEntry {
  name: string;
  description: string;
}

/** The delegation ladder, stated for the model in the terms it must choose between. */
const LADDER = `
CHOOSING A NODE TYPE IS THE MOST IMPORTANT DECISION YOU MAKE.

  tool        Use ONLY when you already know the exact tool AND its arguments,
              and neither depends on anything discovered while running.
              Deterministic plumbing. Costs no model tokens.

  dispatch    Use when the RIGHT TOOL depends on what earlier steps produce.
              List 2 or more plausible candidates; the decision layer picks one
              at runtime and the tool is then called directly. One cheap call,
              no agent loop. PREFER THIS over a pinned tool whenever the choice
              is genuinely contingent.

  agent_task  Use when the subtask is open-ended enough that you cannot draw
              its steps. Give a goal and a candidate tool list; the harness
              plans and executes it. The most capable and the most expensive.

Do not pin a tool you are guessing at. If you find yourself inventing arguments
you cannot know yet, that is a dispatch or an agent_task, not a tool.

A graph where every tool call is pinned will be REJECTED.`.trim();

const SHAPE_RULES = `
STRUCTURE

- Nodes form a DAG. Cycles are rejected.
- Edges express order. A node also reads any upstream node's output through
  "{{node_id.field}}" refs; "{{input.name}}" reads a run variable.
- A judge node's outgoing edges carry "sourceHandle" set to one of its options.
  That is how branching works: only the matching branch runs.
- Independent branches run concurrently. Do not chain steps that do not depend
  on each other just to order them.
- Put "background": true on a node whose failure should not abort the run.

SAFETY

- Anything that sends, submits, pays, publishes or deletes is irreversible.
  Route it through a submit node, or an approval node immediately before it.
- Never put an irreversible tool in an agent_task's availableTools. The harness
  cannot be relied on to respect a restriction; keep those tools out entirely.
- You may include submit and approval nodes. The runtime re-derives the risk
  classification independently of what you claim, so a gate you propose cannot
  be weaker than policy -- but one you omit is a gate the user does not get.

REDACTION

- If a document may contain personal data, put a redact node between loading it
  and any node that sends content to a model.`.trim();

export function buildSynthesisSystemPrompt(tools: ToolCatalogEntry[]): string {
  const toolList = tools.map((t) => '  ' + t.name + ' — ' + t.description).join('\n');

  return [
    'You design agent workflows as a JSON graph document.',
    '',
    'NODE TYPES (use only these): ' + GRAPH_NODE_TYPES.join(', '),
    '',
    LADDER,
    '',
    SHAPE_RULES,
    '',
    'AVAILABLE TOOLS (use only these names, exactly as written):',
    toolList || '  (none connected — avoid tool, dispatch and submit nodes)',
    '',
    'Reply with a single JSON object and nothing else:',
    '{"name": str, "description": str, "nodes": [...], "edges": [...]}',
    '',
    'Each node: {"id", "type", "label", "position": {"x", "y"}, "config", "background"?}.',
    'Each edge: {"id", "source", "target", "sourceHandle"?}.',
    'Lay nodes out top to bottom, x around 0 for the main path and +340 for a',
    'parallel branch, y increasing by 130 per row.',
  ].join('\n');
}

/**
 * The user turn. On a first request `currentGraph` is null; on a follow-up it
 * carries the graph being edited, and the SAME prompt template serves both --
 * which is what makes conversational editing free rather than a second path.
 */
export function buildSynthesisUserPrompt(args: {
  request: string;
  currentGraph: AgentGraph | null;
  /** Appended after a rejected attempt so the retry can repair rather than guess. */
  repairHint?: string;
}): string {
  const parts: string[] = [];

  if (args.currentGraph) {
    parts.push(
      'Here is the current graph. Modify it to satisfy the request below, keeping',
      'node ids stable wherever a node survives, so its position is preserved.',
      '',
      JSON.stringify(
        {
          name: args.currentGraph.name,
          nodes: args.currentGraph.nodes,
          edges: args.currentGraph.edges,
        },
        null,
        1,
      ),
      '',
    );
  }

  parts.push('REQUEST: ' + args.request);

  if (args.repairHint) {
    parts.push(
      '',
      'Your previous attempt was rejected. Fix exactly this and return the whole',
      'document again:',
      args.repairHint,
    );
  }

  return parts.join('\n');
}
