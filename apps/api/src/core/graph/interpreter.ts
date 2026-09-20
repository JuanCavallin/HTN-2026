/**
 * Executes an AgentGraph.
 *
 * ============================================================================
 * EXECUTION MODEL: one memoised promise per node, not a topological walk.
 *
 * Each node awaits the promises of its predecessors. Three things fall out of
 * that for free, which is why it is worth more than the obvious sequential
 * loop:
 *
 *   1. independent branches run CONCURRENTLY with no scheduling code
 *   2. a `background` node is just a node whose failure does not abort the run
 *   3. `{{node.output}}` refs have one obvious resolution point
 *
 * It also means a CYCLE IS A PERMANENT HANG rather than an error, which is why
 * agentGraphSchema rejects cycles at parse time. Do not remove that refinement.
 *
 * TWO VALUES PER NODE, and the distinction is load-bearing:
 *
 *   `value`  -> what downstream {{refs}} see. Stays in this process.
 *   `output` -> what lands on the Step, and is therefore STREAMED OVER SSE
 *               and persisted.
 *
 * A step's output must never carry unredacted content (same rule demo.playbook
 * follows by keeping `raw` in a closure). So `fetch` returns the document as
 * `value` and only its length as `output`.
 * ============================================================================
 */

import type { AgentGraph, GraphEdge, GraphNode, Json, ModelTier } from '@htn/shared';
import type { PlaybookContext, PlaybookOutcome, RedactionOutput } from '../playbooks/types.js';
import { resolveRefs, type RefScope } from './refs.js';
import { routeFor } from './toolRoutes.js';
import { toolDescription, toolRisk, UNKNOWN_TOOL_ACTION_KIND } from './toolRisk.js';

/* -------------------------------------------------------------------------- */
/* Node outcomes                                                              */
/* -------------------------------------------------------------------------- */

interface Ran {
  ran: true;
  /** Visible to downstream {{refs}}. Never streamed. */
  value: unknown;
  /** For a `judge`: which option won, so outgoing branches can be selected. */
  choice?: string;
}

interface Skipped {
  ran: false;
  reason: string;
}

type NodeOutcome = Ran | Skipped;

/**
 * Browser sessions a node opened and deliberately did NOT close.
 *
 * WHY THIS EXISTS: services/toolRoutes.ts keeps the low-level browser family
 * out of graph runs entirely, for a good reason it states plainly -- an opened
 * session is billed and concurrency-capped, and "a graph has no run-scoped
 * cleanup", so a failure or a cancel would leak one.
 *
 * This IS that run-scoped cleanup. A `handoff` has to leave its session open
 * past its own step (the whole point is that later nodes inherit the
 * authenticated browser), so the lifetime moves up to the run, which is the
 * next scope that actually ends. Drained in a `finally` in runGraph, so it
 * runs on success, on a failed node, and on cancellation alike -- the same
 * guarantee core/tools/browser.ts gives per action, one level up.
 */
interface SessionLease {
  hold(sessionId: string): void;
  release(sessionId: string): void;
}

/** What a node executor returns: the internal value and the streamable output. */
interface NodeResult {
  value: unknown;
  output?: Json;
  choice?: string;
}

export interface GraphRunOptions {
  /** Run variables, reachable as {{input.*}}. */
  variables?: Record<string, Json>;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export async function runGraph(
  ctx: PlaybookContext,
  graph: AgentGraph,
  options: GraphRunOptions = {},
): Promise<PlaybookOutcome> {
  const variables = options.variables ?? {};
  const byId = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const list = incoming.get(edge.target);
    if (list) list.push(edge);
    else incoming.set(edge.target, [edge]);
  }

  /** Resolved outcomes so far. Read by resolveRefs; grows as nodes finish. */
  const outcomes = new Map<string, NodeOutcome>();
  const pending = new Map<string, Promise<NodeOutcome>>();

  const held = new Set<string>();
  const lease: SessionLease = {
    hold: (sessionId) => held.add(sessionId),
    release: (sessionId) => held.delete(sessionId),
  };

  /** Built fresh per node so a ref can only see work that has actually finished. */
  function scopeNow(): RefScope {
    const scope: RefScope = { input: variables };
    for (const [id, outcome] of outcomes) {
      if (outcome.ran) scope[id] = outcome.value;
    }
    return scope;
  }

  function resolve(nodeId: string): Promise<NodeOutcome> {
    const existing = pending.get(nodeId);
    if (existing) return existing;

    const promise = (async (): Promise<NodeOutcome> => {
      const node = byId.get(nodeId);
      if (!node) throw new Error('Graph references unknown node "' + nodeId + '"');

      const edges = incoming.get(nodeId) ?? [];

      // A root always runs. Otherwise the node runs when at least one incoming
      // edge is LIVE: its source ran, and either the edge is unconditional or
      // it matches the branch that source chose.
      if (edges.length > 0) {
        const sources = await Promise.all(
          edges.map(async (edge) => ({ edge, outcome: await resolve(edge.source) })),
        );
        const live = sources.some(({ edge, outcome }) => {
          if (!outcome.ran) return false;
          if (edge.sourceHandle === undefined) return true;
          return outcome.choice === edge.sourceHandle;
        });
        if (!live) {
          const skipped: Skipped = { ran: false, reason: 'no live incoming branch' };
          outcomes.set(nodeId, skipped);
          return skipped;
        }
      }

      const result = await executeNode(ctx, node, scopeNow(), graph, lease);
      const ran: Ran = { ran: true, value: result.value, choice: result.choice };
      outcomes.set(nodeId, ran);
      return ran;
    })();

    pending.set(nodeId, promise);
    return promise;
  }

  // Settle EVERY node before deciding the run's fate. Letting a rejection
  // propagate immediately would mark the run terminal while sibling branches
  // were still emitting steps — and the web client closes its SSE stream on a
  // terminal status, so those steps would never be seen.
  const settled = await Promise.allSettled(graph.nodes.map((n) => resolve(n.id)));

  // Every held session, released. Before the failure check below, so a graph
  // that throws still gives its sessions back.
  await releaseHeldSessions(ctx, held);

  for (const [index, result] of settled.entries()) {
    const node = graph.nodes[index] as GraphNode;
    if (result.status !== 'rejected') continue;
    const message = (result.reason as Error).message;

    // A background node is fire-and-forget: its failure is reported, not fatal.
    if (node.background) {
      await ctx.log('warn', 'Background node "' + node.label + '" failed: ' + message);
      continue;
    }
    throw new Error('Node "' + node.label + '" (' + node.type + ') failed: ' + message);
  }

  return summarise(graph, outcomes, variables);
}

/**
 * Give back every session the run is still holding.
 *
 * Best effort and never throws: a session that cannot be released is a billing
 * annoyance, while letting this reject would turn a SUCCESSFUL run into a
 * failed one at the very last moment. The same reasoning core/tools/browser.ts
 * applies to its own `finally`.
 *
 * Closing goes through the tool route like any other call, so the release is
 * gated, ledgered and visible on the canvas rather than being a side channel.
 */
async function releaseHeldSessions(ctx: PlaybookContext, held: Set<string>): Promise<void> {
  if (held.size === 0) return;
  const tool = ctx.providerFor('browser') + '.close';

  await Promise.all(
    [...held].map(async (sessionId) => {
      try {
        const route = await routeFor(tool);
        await route.call(ctx, {
          stepId: 'run-teardown',
          tool,
          args: { sessionId },
          description: 'Release browser session ' + sessionId,
          policyRule: 'run-teardown-session-release',
        });
      } catch (err) {
        await ctx
          .log('warn', 'Could not release browser session ' + sessionId + ': ' + String(err))
          .catch(() => undefined);
      }
    }),
  );
  held.clear();
}

/* -------------------------------------------------------------------------- */
/* Per-node execution                                                         */
/* -------------------------------------------------------------------------- */

async function executeNode(
  ctx: PlaybookContext,
  node: GraphNode,
  scope: RefScope,
  graph: AgentGraph,
  lease: SessionLease,
): Promise<NodeResult> {
  switch (node.type) {
    case 'fetch':
      return runFetch(ctx, node, scope);
    case 'redact':
      return runRedact(ctx, node, scope);
    case 'decide':
      return runDecide(ctx, node, scope, graph);
    case 'tool':
      return runTool(ctx, node, scope);
    case 'dispatch':
      return runDispatch(ctx, node, scope);
    case 'judge':
      return runJudge(ctx, node, scope);
    case 'agent_task':
      return runAgentTaskNode(ctx, node, scope);
    case 'swarm':
      return runSwarm(ctx, node, scope, graph);
    case 'submit':
      return runSubmit(ctx, node, scope);
    case 'approval':
      return runApproval(ctx, node, scope);
    case 'handoff':
      return runHandoff(ctx, node, scope, lease);
  }
}

function runFetch(
  ctx: PlaybookContext,
  node: Extract<GraphNode, { type: 'fetch' }>,
  scope: RefScope,
): Promise<NodeResult> {
  const cfg = resolveRefs(node.config, scope);
  return ctx
    .step({ label: node.label, kind: 'fetch', nodeId: node.id }, async () => ({
      source: cfg.source,
      // Metadata only. The document itself goes downstream as `value` and never
      // onto the wire.
      bytes: (cfg.text ?? '').length,
    }))
    .then((output) => ({
      value: { source: cfg.source, text: cfg.text ?? '' },
      output: output as Json,
    }));
}

async function runRedact(
  ctx: PlaybookContext,
  node: Extract<GraphNode, { type: 'redact' }>,
  scope: RefScope,
): Promise<NodeResult> {
  const cfg = resolveRefs(node.config, scope);
  const text = typeof cfg.text === 'string' ? cfg.text : '';

  // The step callback's return value is what actually gets PERSISTED as
  // Step.output (see ctx.step's contract) -- so it has to be the curated,
  // safe-to-store shape directly, the same pattern runFetch uses. Returning
  // ctx.redact()'s raw RedactionOutput here and building a separate curated
  // `output` object below (as this used to do) meant that second object was
  // silently never applied to anything: `spans` never reached the Step, so
  // an assertion path like "nodes.redact.spans" could never resolve. `full`
  // captures the raw result too, for `value` below -- downstream {{refs}}
  // like {{redact.redacted}} need it, and it must never itself be persisted.
  let full: RedactionOutput;
  const output = await ctx.step(
    { label: node.label, kind: 'redact', nodeId: node.id },
    async () => {
      full = await ctx.redact(text, cfg.field);
      return { spans: full.redactions.length, hadSensitive: full.hadSensitive };
    },
  );
  const redaction = full!;

  return {
    // `redacted` is placeholders-only and therefore safe, but kept out of the
    // step output anyway: outputs are persisted, and there is no reason to
    // store a second copy of the document.
    value: {
      redacted: redaction.redacted,
      redactions: redaction.redactions,
      hadSensitive: redaction.hadSensitive,
      spans: redaction.redactions.length,
    },
    output,
  };
}

/**
 * Every redaction recorded by any redact node that has already run. Attached to
 * the call context of outbound model calls so the ledger records WHAT CLASS of
 * data was in play. Slightly over-reports (it does not trace which refs a node
 * actually used), which is the safe direction to be wrong in.
 */
function redactionsInScope(scope: RefScope): { placeholder: string; type: string }[] {
  const all: { placeholder: string; type: string }[] = [];
  for (const value of Object.values(scope)) {
    if (value && typeof value === 'object' && 'redactions' in value) {
      const spans = (value as { redactions?: unknown }).redactions;
      if (Array.isArray(spans)) all.push(...(spans as { placeholder: string; type: string }[]));
    }
  }
  return all;
}

async function runDecide(
  ctx: PlaybookContext,
  node: Extract<GraphNode, { type: 'decide' }>,
  scope: RefScope,
  graph: AgentGraph,
): Promise<NodeResult> {
  const cfg = resolveRefs(node.config, scope);
  const redactions = redactionsInScope(scope);

  const text = await ctx.step(
    {
      label: node.label,
      kind: 'decide',
      nodeId: node.id,
      providerId: ctx.providerFor('text.model'),
    },
    async (step) => {
      const model = ctx.provider('text.model');
      const res = await model.complete(
        {
          prompt: cfg.prompt,
          system: cfg.system,
          tier: cfg.tier,
          maxTokens: cfg.maxTokens ?? 512,
        },
        ctx.callContext({
          stepId: step.id,
          policyRule:
            redactions.length > 0 ? 'redacted-payload-may-leave' : 'graph-node-completion',
          redactions,
        }),
      );
      return res.ok ? res.data.text : 'Unavailable (' + res.error.code + ')';
    },
  );

  void graph;
  return { value: { text }, output: { chars: text.length } };
}

/* ---------------------------------------------------------------- tool calls */

/**
 * Classify, gate if needed, then call. Shared by `tool`, `dispatch` and
 * `submit` so there is exactly ONE path from "a graph wants to call a tool" to
 * the tool actually being called — a second path would be a second chance to
 * forget the approval gate.
 */
async function callToolGated(
  ctx: PlaybookContext,
  args: {
    stepId: string;
    tool: string;
    toolArgs: Record<string, Json>;
    actionKind?: string;
    description: string;
    amountCents?: number;
    /** Force a human regardless of classification (an explicit `submit`). */
    forceApproval?: boolean;
  },
): Promise<unknown> {
  const route = await routeFor(args.tool);
  const risk = toolRisk(args.tool, args.actionKind);

  // A route that runs its own `authorize_action` gates the CONCRETE action
  // itself, so gating here too would ask a human twice. Two things still gate
  // in this file regardless: a route with no gate of its own, and an explicit
  // `submit` node -- "always stop for a human" must not depend on which route
  // happens to own the tool.
  const gateHere = !route.gatesItself || args.forceApproval;

  if (gateHere) {
    if (risk.unknown) {
      await ctx.log(
        'warn',
        'Tool "' +
          args.tool +
          '" is not classified, so it is being treated as irreversible and sent for approval. ' +
          'See docs/tool-registry-handoff.md.',
      );
    }

    await ctx.requireApproval(args.stepId, {
      kind: risk.kind,
      description: args.description,
      amountCents: args.amountCents,
      // An unclassified tool fails CLOSED. So does an explicit submit node.
      reversibility: risk.unknown || args.forceApproval ? 'irreversible' : undefined,
      payload: { tool: args.tool, args: args.toolArgs } as Json,
    });
  }

  return route.call(ctx, {
    stepId: args.stepId,
    tool: args.tool,
    args: args.toolArgs,
    description: args.description,
    policyRule:
      risk.kind === UNKNOWN_TOOL_ACTION_KIND
        ? 'human-approved-unclassified-tool'
        : 'graph-node-tool-call',
  });
}

/**
 * The browser-decision fields of a tool result, and ONLY those, for streaming.
 *
 * A tool result as a whole must never reach `Step.output` -- it is arbitrary,
 * it can be a page, and output is streamed AND persisted (see this file's
 * header). But a browser action's result carries the one thing the canvas most
 * needs and currently throws away: WHICH element was chosen, how sure the
 * decider was, and whether that answer cost a model call or was replayed from
 * cache for free.
 *
 * So this is an explicit allowlist of small, non-content fields, never a
 * spread. `target` is a control's accessible label, which core/tools/browser.ts
 * already treats as safe to return (the `inspect` operation returns a whole
 * table of them); it is not page text.
 *
 * Returns undefined for any result that is not a browser action, so a normal
 * tool node's output is unchanged.
 */
function browserDecisionOf(result: unknown): Json | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const r = result as Record<string, unknown>;
  if (typeof r.operation !== 'string' || typeof r.decisionSource !== 'string') return undefined;

  return {
    operation: r.operation,
    index: typeof r.index === 'number' ? r.index : null,
    target: typeof r.target === 'string' ? r.target : null,
    url: typeof r.url === 'string' ? r.url : null,
    navigated: r.navigated === true,
    // TRUTHFUL LABELING, as core/tools/browser.ts puts it: the UI must not show
    // a string match as a model decision, or a cache replay as a live call.
    decisionSource: r.decisionSource,
    confidence: typeof r.confidence === 'number' ? r.confidence : null,
    rationale: typeof r.rationale === 'string' ? r.rationale : null,
  };
}

async function runTool(
  ctx: PlaybookContext,
  node: Extract<GraphNode, { type: 'tool' }>,
  scope: RefScope,
): Promise<NodeResult> {
  const cfg = resolveRefs(node.config, scope);
  const route = await routeFor(cfg.tool);

  // The full result is kept in a CLOSURE VARIABLE and never returned from the
  // step, exactly as demo.playbook.ts keeps `raw` out of its outputs. What the
  // step returns is what gets streamed and stored, so the only safe way to have
  // both is to let the value escape sideways.
  let full: unknown;

  const output = await ctx.step(
    { label: node.label, kind: 'tool', nodeId: node.id, providerId: route.providerFor(ctx) },
    async (step) => {
      full = await callToolGated(ctx, {
        stepId: step.id,
        tool: cfg.tool,
        toolArgs: cfg.args,
        actionKind: cfg.actionKind,
        description: 'Call ' + cfg.tool,
      });
      const decision = browserDecisionOf(full);
      return { tool: cfg.tool, ...(decision ? { decision } : {}) };
    },
  );

  return { value: { tool: cfg.tool, result: full }, output: output as Json };
}

/**
 * THE CHEAP MIDDLE RUNG. The decision layer picks one tool from the candidate
 * set and we call it directly — no agent harness, so no multi-turn model loop.
 * One cheap decide plus one tool call.
 */
/**
 * A dispatch node's arguments for the tool the decision layer just chose.
 *
 * `argsFrom: 'static'` is the default and costs nothing: the author already
 * wrote the args per candidate. `'model'` is for the case the author could NOT
 * write them -- the right query or URL depends on what upstream nodes found --
 * and costs one CHEAP completion, which is still far less than handing the job
 * to a harness. The schema has promised this since it was written; until now
 * nothing read the field, so `'model'` silently dispatched `{}` and any tool
 * needing an argument failed.
 *
 * FAIL SOFT, toward the author's own args: an unusable reply (not JSON, not an
 * object) falls back to whatever `static` holds rather than throwing. The gate
 * has not run yet at this point -- this is argument composition, not a
 * permission decision, exactly as core/tools/composeText.ts is for typing.
 */
async function dispatchArgs(
  ctx: PlaybookContext,
  stepId: string,
  spec: {
    tool: string;
    goal: string;
    evidence?: string;
    argsFrom: 'static' | 'model';
    static: Record<string, Json>;
  },
): Promise<Record<string, Json>> {
  if (spec.argsFrom !== 'model') return spec.static;

  const description = toolDescription(spec.tool);
  const res = await ctx.provider('text.model').complete(
    {
      system:
        'You produce ARGUMENTS for one tool call, as JSON. Reply with a single JSON ' +
        'object and nothing else: the arguments themselves, no wrapper, no prose. ' +
        'Use only what the tool takes; omit anything you are unsure of.',
      prompt: [
        'TOOL: ' + spec.tool + (description ? ' — ' + description : ''),
        'GOAL: ' + spec.goal,
        ...(spec.evidence ? ['', 'CONTEXT:', spec.evidence] : []),
        ...(Object.keys(spec.static).length > 0
          ? [
              '',
              'STARTING POINT (override only what the goal requires):',
              JSON.stringify(spec.static),
            ]
          : []),
      ].join('\n'),
      tier: 'cheap',
      maxTokens: 512,
      json: true,
    },
    ctx.callContext({ stepId, policyRule: 'graph-node-tool-args' }),
  );

  if (!res.ok) {
    await ctx.log('warn', 'Could not infer arguments for ' + spec.tool + "; using the node's own.");
    return spec.static;
  }

  try {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(res.data.text);
    const body = fenced ? (fenced[1] as string) : res.data.text;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    const parsed: unknown =
      start === -1 || end < start ? null : JSON.parse(body.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return spec.static;
    // The author's args are the floor: an inference may add or refine, never drop.
    return { ...spec.static, ...(parsed as Record<string, Json>) };
  } catch {
    await ctx.log(
      'warn',
      'Inferred arguments for ' + spec.tool + " were not JSON; using the node's own.",
    );
    return spec.static;
  }
}

async function runDispatch(
  ctx: PlaybookContext,
  node: Extract<GraphNode, { type: 'dispatch' }>,
  scope: RefScope,
): Promise<NodeResult> {
  const cfg = resolveRefs(node.config, scope);

  const picked = await ctx.step(
    {
      label: node.label,
      kind: 'dispatch',
      nodeId: node.id,
      providerId: ctx.providerFor('decision'),
    },
    async (step) => {
      const decider = ctx.provider('decision');
      const decision = await decider.decide(
        {
          question: cfg.goal,
          options: cfg.candidateTools,
          evidence: cfg.evidence,
        },
        ctx.callContext({ stepId: step.id, policyRule: 'graph-node-tool-selection' }),
      );

      // Fail closed, exactly as runAgentTask does: a decision-layer outage must
      // not widen what can be called. With no choice there is nothing to run.
      if (!decision.ok) {
        throw new Error('Tool selection failed (' + decision.error.code + '); nothing dispatched.');
      }

      const tool = cfg.candidateTools.includes(decision.data.choice)
        ? decision.data.choice
        : undefined;
      if (!tool) {
        throw new Error(
          'Tool selection returned "' + decision.data.choice + '", which is not a candidate.',
        );
      }

      // Same headline number as the expensive path: N candidates -> 1 exposed.
      await ctx.recordSchedule({
        stepId: step.id,
        requestedCapability: 'toolbox',
        selectedProvider: ctx.providerFor('toolbox'),
        modelTier: 'cheap' as ModelTier,
        availableTools: cfg.candidateTools,
        exposedTools: [tool],
        confidence: decision.data.confidence,
        rule: 'dispatch-selected-single-tool',
      });

      const toolArgs = await dispatchArgs(ctx, step.id, {
        tool,
        goal: cfg.goal,
        evidence: cfg.evidence,
        argsFrom: cfg.argsFrom,
        static: (cfg.args[tool] ?? {}) as Record<string, Json>,
      });

      const result = await callToolGated(ctx, {
        stepId: step.id,
        tool,
        toolArgs,
        actionKind: cfg.actionKind,
        description: cfg.goal + ' (selected: ' + tool + ')',
      });

      return { tool, confidence: decision.data.confidence, result };
    },
  );

  return {
    value: picked,
    output: { tool: picked.tool, confidence: picked.confidence },
  };
}

async function runJudge(
  ctx: PlaybookContext,
  node: Extract<GraphNode, { type: 'judge' }>,
  scope: RefScope,
): Promise<NodeResult> {
  const cfg = resolveRefs(node.config, scope);

  const verdict = await ctx.step(
    { label: node.label, kind: 'judge', nodeId: node.id, providerId: ctx.providerFor('decision') },
    async (step) => {
      const decider = ctx.provider('decision');
      const res = await decider.decide(
        { question: cfg.question, options: cfg.options, evidence: cfg.evidence },
        ctx.callContext({ stepId: step.id, policyRule: 'aggregate-no-pii' }),
      );
      // A judge that cannot reach its provider takes the FIRST option, which is
      // the convention elsewhere in the codebase: options[0] is the cautious
      // branch. Never invent a branch that is not in the list.
      return res.ok
        ? { choice: res.data.choice, confidence: res.data.confidence }
        : { choice: cfg.options[0] as string, confidence: 0 };
    },
  );

  const choice = cfg.options.includes(verdict.choice) ? verdict.choice : (cfg.options[0] as string);
  return { value: verdict, output: verdict as unknown as Json, choice };
}

async function runAgentTaskNode(
  ctx: PlaybookContext,
  node: Extract<GraphNode, { type: 'agent_task' }>,
  scope: RefScope,
): Promise<NodeResult> {
  const cfg = resolveRefs(node.config, scope);

  // The harness field exists so the abstraction is real and visible in the
  // editor, but only one runtime is wired. Failing loudly beats silently
  // running somewhere the author did not choose.
  if (cfg.harness && cfg.harness !== 'hermes') {
    throw new Error(
      'Harness "' + cfg.harness + '" is not wired yet; only "hermes" serves agent.runtime today.',
    );
  }

  const task = await ctx.runAgentTask({
    label: node.label,
    nodeId: node.id,
    goal: cfg.goal,
    context: { scope: summariseScope(scope) },
    availableTools: cfg.availableTools,
    pollIntervalMs: cfg.pollIntervalMs,
    maxPolls: cfg.maxPolls,
    inactivityTimeoutMs: cfg.inactivityTimeoutMs,
    maxDurationMs: cfg.maxDurationMs,
    maxFailedToolCalls: cfg.maxFailedToolCalls,
  });

  return {
    value: {
      result: task.result,
      toolCalls: task.toolCalls,
      exposedTools: task.scheduleDecision.exposedTools,
    },
  };
}

async function runSwarm(
  ctx: PlaybookContext,
  node: Extract<GraphNode, { type: 'swarm' }>,
  scope: RefScope,
  graph: AgentGraph,
): Promise<NodeResult> {
  const cfg = resolveRefs(node.config, scope);
  void graph;

  const outcomes = await ctx.fanOut<string, { item: string; result: unknown }>({
    label: node.label,
    nodeId: node.id,
    items: cfg.items,
    concurrency: cfg.concurrency ?? Math.min(cfg.items.length, 8),
    workerLabel: (item) => item,
    worker: async (item, _index, step) => {
      // A worker is a tool call or a completion, per config. `{{item}}` is the
      // one extra ref available inside a worker.
      const workerScope: RefScope = { ...scope, item };

      if (cfg.workerTool) {
        const result = await callToolGated(ctx, {
          stepId: step.id,
          tool: cfg.workerTool,
          toolArgs: { item },
          description: 'Swarm worker: ' + cfg.workerTool + ' for ' + item,
        });
        return { item, result };
      }

      if (cfg.workerPrompt) {
        const model = ctx.provider('text.model');
        const res = await model.complete(
          { prompt: resolveRefs(cfg.workerPrompt, workerScope), maxTokens: 256, tier: 'cheap' },
          ctx.callContext({
            stepId: step.id,
            policyRule: 'graph-swarm-worker',
            redactions: redactionsInScope(scope),
          }),
        );
        return { item, result: res.ok ? res.data.text : null };
      }

      return { item, result: null };
    },
  });

  const results = outcomes
    .filter((o) => o.ok)
    .map((o) => (o as { ok: true; value: { item: string; result: unknown } }).value);

  return {
    value: { results, total: outcomes.length, failed: outcomes.length - results.length },
    output: { workers: outcomes.length, failed: outcomes.length - results.length },
  };
}

async function runSubmit(
  ctx: PlaybookContext,
  node: Extract<GraphNode, { type: 'submit' }>,
  scope: RefScope,
): Promise<NodeResult> {
  const cfg = resolveRefs(node.config, scope);

  const result = await ctx.step(
    { label: node.label, kind: 'submit', nodeId: node.id, providerId: ctx.providerFor('toolbox') },
    async (step) =>
      callToolGated(ctx, {
        stepId: step.id,
        tool: cfg.tool,
        toolArgs: cfg.args,
        actionKind: cfg.actionKind,
        description: cfg.description,
        amountCents: cfg.amountCents,
        // A submit node means the author already decided this is consequential.
        forceApproval: true,
      }),
  );

  return { value: { tool: cfg.tool, result }, output: { tool: cfg.tool, submitted: true } };
}

async function runApproval(
  ctx: PlaybookContext,
  node: Extract<GraphNode, { type: 'approval' }>,
  scope: RefScope,
): Promise<NodeResult> {
  const cfg = resolveRefs(node.config, scope);

  await ctx.step({ label: node.label, kind: 'approval', nodeId: node.id }, async (step) => {
    // An explicit gate always blocks: the author put it there on purpose, so
    // do not let the reversibility heuristic decide it away.
    await ctx.requireApproval(step.id, {
      kind: 'approval_gate',
      description: cfg.description,
      amountCents: cfg.amountCents,
      reversibility: 'irreversible',
    });
    return { approved: true };
  });

  return { value: { approved: true }, output: { approved: true } };
}

/** Ten minutes. A person who has walked away, not a person who is reading. */
const HANDOFF_TIMEOUT_MS = 600_000;

/**
 * Fail the node if nobody acts in time.
 *
 * `Promise.race` and NOT an abort of the underlying approval: the approval
 * genuinely stays pending server-side, and saying otherwise in the UI would be
 * a lie. What the timeout bounds is how long the RUN waits, which is the thing
 * that actually needs bounding. The timer is always cleared, so a resolved
 * handoff cannot leave a live handle holding the process open.
 */
async function withHandoffTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Handoff "' +
                  label +
                  '" timed out after ' +
                  Math.round(ms / 1000) +
                  's with nobody acting. The agent does NOT attempt this step itself.',
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * THE HUMAN DOES IT — see handoffNodeSchema for why this is not an `approval`.
 *
 * Mechanically this is `runApproval` with a browser session attached, and that
 * is deliberate: the blocking primitive (`ctx.requireApproval` ->
 * `waitForApproval` -> POST /api/approvals/:id/decide) is already correct,
 * already cancellable via the run's AbortSignal, and already surfaces in the
 * UI. Inventing a second way to block a run would mean a second way to get
 * cancellation wrong.
 *
 * What is NOT shared with `approval`:
 *
 *   - the session is opened through `callToolGated`, exactly as a `tool` node
 *     would, so opening a browser is still authorized and still lands in the
 *     egress ledger. A handoff does not get a private back door to the network.
 *   - the session STAYS OPEN on the way out when this node opened it, because
 *     the whole point is that downstream nodes inherit the authenticated
 *     session. That makes this the one node that deliberately leaks a session
 *     past its own step, so it returns the id as `value` for a downstream
 *     {{ref}} and the run's own teardown is what finally releases it.
 *
 * NO CREDENTIAL PASSES THROUGH THIS FUNCTION. There is nothing here that reads
 * a secret, and `output` carries only the instruction, the session id and how
 * the wait ended. Keep it that way.
 */
async function runHandoff(
  ctx: PlaybookContext,
  node: Extract<GraphNode, { type: 'handoff' }>,
  scope: RefScope,
  lease: SessionLease,
): Promise<NodeResult> {
  const cfg = resolveRefs(node.config, scope);

  // An inherited session belongs to whoever opened it. Only a session THIS
  // node opens is one this node may hand downstream.
  const inherited = typeof cfg.sessionId === 'string' && cfg.sessionId.length > 0;

  const result = await ctx.step(
    { label: node.label, kind: 'handoff', nodeId: node.id },
    async (step) => {
      let sessionId = inherited ? cfg.sessionId : undefined;

      if (!inherited) {
        // The browser descriptors are registered per PROVIDER ('browserbase.open',
        // 'localbrowser.open'), so naming one means naming a backend. Asking the
        // capability binding is the only way to do that without hardcoding a
        // vendor here -- and it does not violate providerFor's "labelling only"
        // rule in the way that rule exists to prevent: the BEHAVIOUR is
        // identical either way, and the executor re-resolves the real backend
        // from the authorization result regardless of which id we passed.
        const tool = ctx.providerFor('browser') + '.open';

        // Through the gate like any other tool call. `open` is the one browser
        // operation that deliberately does NOT close what it opened (see
        // core/tools/browser.ts), which is exactly the lifetime we want.
        const opened = (await callToolGated(ctx, {
          stepId: step.id,
          tool,
          toolArgs: cfg.url ? { url: cfg.url } : {},
          actionKind: 'read_page',
          description: 'Open a browser for a human handoff' + (cfg.url ? ' at ' + cfg.url : ''),
        })) as { sessionId?: string } | null;

        sessionId = opened?.sessionId;
        if (!sessionId) {
          throw new Error(
            'Handoff "' + node.label + '" could not open a browser session to hand over.',
          );
        }

        // Held for the REST OF THE RUN, not this step: downstream nodes inherit
        // the authenticated session. runGraph's finally is what gives it back.
        lease.hold(sessionId);
      }

      // BLOCKS. Rejection throws ApprovalRejectedError and fails the node,
      // which is correct: a person declining to do the step is not a step that
      // can be worked around.
      const waiting = ctx.requireApproval(step.id, {
        kind: 'human_handoff',
        description: cfg.instruction,
        // Irreversible so the gate can never classify this away. A handoff is
        // an explicit author decision, exactly like an `approval` node.
        reversibility: 'irreversible',
        payload: {
          instruction: cfg.instruction,
          sessionId,
          resumeWhen: cfg.resumeWhen,
          ...(cfg.expectUrl ? { expectUrl: cfg.expectUrl } : {}),
        },
      });

      // THE TIMEOUT FAILS THE RUN. It never falls through to letting the agent
      // do it -- see handoffNodeSchema. The default is long on purpose: it is
      // sized for "the person walked away", not "the person is still reading".
      await withHandoffTimeout(waiting, cfg.timeoutMs ?? HANDOFF_TIMEOUT_MS, node.label);

      return { sessionId, handedOff: true, resumeWhen: cfg.resumeWhen };
    },
  );

  return {
    value: { sessionId: result.sessionId, handedOff: true },
    output: result as Json,
  };
}

/* -------------------------------------------------------------------------- */
/* Result shaping                                                             */
/* -------------------------------------------------------------------------- */

/** Compact view of the scope for handing to an agent runtime as context. */
function summariseScope(scope: RefScope): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(scope)) {
    if (key === 'input') continue;
    out[key] = value;
  }
  return out;
}

function toJson(value: unknown): Json {
  try {
    return JSON.parse(JSON.stringify(value)) as Json;
  } catch {
    return String(value);
  }
}

function summarise(
  graph: AgentGraph,
  outcomes: Map<string, NodeOutcome>,
  variables: Record<string, Json>,
): PlaybookOutcome {
  const ran = [...outcomes.values()].filter((o) => o.ran).length;
  const skipped = outcomes.size - ran;

  const nodes: Record<string, Json> = {};
  for (const [id, outcome] of outcomes) {
    nodes[id] = outcome.ran ? toJson(outcome.value) : { skipped: true, reason: outcome.reason };
  }

  // Terminal nodes (nothing depends on them) are the graph's answer.
  const hasOutgoing = new Set(graph.edges.map((e) => e.source));
  const terminal = graph.nodes.filter((n) => !hasOutgoing.has(n.id) && outcomes.get(n.id)?.ran);

  const headline = terminal.length > 0 ? terminal.map((n) => n.label).join(', ') : graph.name;

  return {
    summary:
      'Ran ' +
      ran +
      ' of ' +
      graph.nodes.length +
      ' node(s)' +
      (skipped > 0 ? ' (' + skipped + ' skipped by branching)' : '') +
      '. ' +
      headline +
      '.',
    result: {
      graphId: graph.id,
      graphName: graph.name,
      graphVersion: graph.version,
      nodesRan: ran,
      nodesSkipped: skipped,
      variables,
      nodes,
    },
  };
}
