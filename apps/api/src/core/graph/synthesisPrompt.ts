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
 *
 * THE CONFIG SCHEMA IS THE REAL agentGraphSchema, not hand-written prose.
 * Earlier this prompt only described node types in English ("a judge node
 * has a question and options") and left the model to guess exact field
 * names for everything else -- which it did, wrong, consistently: e.g. a
 * judge node with no recognisable `question` field, rejected by validation,
 * on both the original attempt AND the one repair retry, because the model
 * was never shown what the field is actually called. `z.toJSONSchema()` is
 * generated from `graphNodeSchema` itself below, so it is IMPOSSIBLE for
 * this reference to drift from what the validator will actually accept --
 * unlike a second hand-written description of the same shape would.
 */

import { z } from 'zod';
import { GRAPH_NODE_TYPES, graphEdgeSchema, graphNodeSchema, type AgentGraph } from '@htn/shared';

export interface ToolCatalogEntry {
  name: string;
  description: string;
}

/**
 * Computed once at module load, not per request -- it's a pure function of
 * the schema. Minified: pretty-printing this is ~18KB of mostly indentation
 * for no comprehension benefit to the model, ~8KB minified. Still real
 * tokens, but cheap next to a frontier call already spending up to 4096
 * output tokens, and far cheaper than a wasted attempt from a guessed field
 * name failing validation.
 */
const NODE_CONFIG_SCHEMA = JSON.stringify(z.toJSONSchema(graphNodeSchema));
const EDGE_SCHEMA = JSON.stringify(z.toJSONSchema(graphEdgeSchema));

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
- agent_task's "harness" field is validated against every known provider id,
  but only "hermes" is actually wired to run one today. OMIT "harness"
  entirely (it then defaults correctly), or set it to "hermes" explicitly --
  never any other value, even if it sounds like a better fit for the task
  (e.g. a browsing-heavy goal does NOT mean "browserbase" here). Setting
  anything else validates fine and then fails when the graph actually runs.

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
    'EVERY node MUST validate against this JSON Schema. Match field names',
    'EXACTLY — do not invent, rename, or nest a field differently than shown',
    'here, and do not add fields not listed. `type` selects which branch of',
    'this schema applies to that node; that branch is the ONLY shape it may',
    'take.',
    NODE_CONFIG_SCHEMA,
    '',
    'Every edge MUST validate against this JSON Schema:',
    EDGE_SCHEMA,
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
