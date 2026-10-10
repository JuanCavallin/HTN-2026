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
  /** Editor grouping (`web`, `mail`, ...). Also how a family of tools is recognised here. */
  group?: string;
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

/**
 * Steering for live-web work, DERIVED from what the catalog actually contains.
 *
 * Without this a synthesiser reaches for `agent_task` on every "look it up"
 * request -- it is the only node that sounds like it can browse -- and that
 * sends a lookup to a general-purpose agent that searches slowly, unreliably,
 * and outside our gate and ledger. When a `web` tool is listed, say so; when
 * none is (no browser backend configured), say nothing rather than promise one.
 * Tool names are read from the catalog, never written here, so a renamed or
 * added web tool needs no edit to this file.
 */
function webLookupRules(tools: ToolCatalogEntry[]): string {
  const web = tools.filter((t) => t.group === 'web').map((t) => t.name);
  if (web.length === 0) return '';

  return [
    'LIVE WEB LOOKUPS',
    '',
    '- These tools fetch live pages through a gated cloud browser: ' + web.join(', ') + '.',
    '  Use them, as `tool` nodes (or as `dispatch` candidates), for ANY step that needs',
    '  current information from the internet: searching, checking a price, reading a page.',
    '- Add a web lookup ONLY when the request needs information from the internet. Work on',
    '  the user\'s own documents, notes or records needs none: do not add one "for context"',
    '  (the query leaves the machine).',
    '- Do NOT hand a web lookup to an `agent_task` -- that includes "deep research" and',
    '  fallback branches. If one lookup might come back thin, add a second web tool node, or',
    '  a `dispatch` between web tools. Keep `agent_task` for open-ended work no listed tool',
    '  fits. A lookup done by a tool is cheaper, faster and audited.',
    "- Each tool's description states its args and result fields. Pass one lookup's result",
    '  to a later node with a ref, e.g. "{{search.result.text}}" for a node with id "search".',
  ].join('\n');
}

export function buildSynthesisSystemPrompt(tools: ToolCatalogEntry[]): string {
  const toolList = tools
    .map((t) => '  ' + t.name + (t.group ? ' [' + t.group + ']' : '') + ' — ' + t.description)
    .join('\n');
  const webRules = webLookupRules(tools);

  return [
    'You design agent workflows as a JSON graph document.',
    '',
    'NODE TYPES (use only these): ' + GRAPH_NODE_TYPES.join(', '),
    '',
    LADDER,
    '',
    SHAPE_RULES,
    '',
    ...(webRules ? [webRules, ''] : []),
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
      'Here is the current graph. Change ONLY what the request below actually',
      'requires. Reproduce every other node and edge exactly as given -- same id,',
      'same label, same config, same position -- and keep the ids of any node you',
      'DO change the same as well, so its position is preserved. Do not rename,',
      'reorder, restructure, or "clean up" anything the request did not ask about,',
      'even if you can see a way to improve it.',
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
