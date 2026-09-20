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
import type { PlaybookContext, PlaybookOutcome } from '../playbooks/types.js';
import { resolveRefs, type RefScope } from './refs.js';
import { toolRisk, UNKNOWN_TOOL_ACTION_KIND } from './toolRisk.js';

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
 * A `handoff` has to leave its session open past its own step -- the whole
 * point is that a person signs in and LATER nodes inherit the authenticated
 * browser. So the lifetime moves up to the run, which is the next scope that
 * actually ends. Drained in runGraph before the failure check, so it runs on
 * success, on a failed node, and on cancellation alike.
 *
 * Without this an opened session leaks, and a Browserbase session is billed
 * and concurrency-capped.
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

  // Every held session, released. BEFORE the failure check below, so a graph
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
      return runTool(ctx, node, scope, lease);
    case 'dispatch':
      return runDispatch(ctx, node, scope, lease);
    case 'judge':
      return runJudge(ctx, node, scope);
    case 'agent_task':
      return runAgentTaskNode(ctx, node, scope);
    case 'swarm':
      return runSwarm(ctx, node, scope, graph);
    case 'submit':
      return runSubmit(ctx, node, scope, lease);
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

  const redaction = await ctx.step(
    { label: node.label, kind: 'redact', nodeId: node.id },
    async () => ctx.redact(text, cfg.field),
  );

  return {
    // `redacted` is placeholders-only and therefore safe, but keep it out of the
    // step output anyway: outputs are persisted, and there is no reason to store
    // a second copy of the document.
    value: {
      redacted: redaction.redacted,
      redactions: redaction.redactions,
      hadSensitive: redaction.hadSensitive,
      spans: redaction.redactions.length,
    },
    output: { spans: redaction.redactions.length, hadSensitive: redaction.hadSensitive },
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
    /**
     * Run-scoped session lease. A browser `open` deliberately does NOT close
     * what it opened (core/tools/browser.ts sets ownsSession = false and hands
     * the id back), so without this a plain `tool` node that opens a browser
     * leaks a billed, concurrency-capped session on every run. Handing the
     * lease down means the run releases it, exactly as a handoff's is.
     */
    lease?: SessionLease;
  },
): Promise<unknown> {
  const risk = toolRisk(args.tool, args.actionKind);

  // THE BROKER FIRST. A tool AgentOS itself registers -- the browser family,
  // local tools, anything reached over MCP -- executes through the same trusted
  // path a harness turn uses: schema-validated arguments, availability and
  // scope checks, exact-action authorization, and its own approval gate.
  //
  // This is not an optimisation. Every graph tool call used to go to the
  // `toolbox` provider, so a node naming `browserbase.open` was handed to
  // Composio, which has never heard of it: "Tool/version was not resolved from
  // trusted Composio catalog metadata". The toolbox owns its own names and
  // nothing else.
  //
  // NO requireApproval AROUND AN ORDINARY BROKERED CALL. The broker gates the
  // concrete action itself; gating here as well asks a person twice for one
  // call. That is the same rule the old tool routes stated as `gatesItself`.
  //
  // AN EXPLICIT `submit` NODE IS THE ONE EXCEPTION. "Always stop for a human"
  // is the author's decision and must not depend on how the registry happens
  // to classify the tool -- a submit node naming a reversible tool still stops.
  // So it gates here FIRST and is then executed through the broker like
  // anything else, rather than being pushed down the toolbox path where its
  // name would not resolve.
  if (args.forceApproval) {
    await ctx.requireApproval(args.stepId, {
      kind: risk.kind,
      description: args.description,
      amountCents: args.amountCents,
      reversibility: 'irreversible',
      payload: { tool: args.tool, args: args.toolArgs } as Json,
    });
  }

  const brokered = await ctx.callBrokeredTool({
    stepId: args.stepId,
    toolId: args.tool,
    args: args.toolArgs,
  });
  // null means the registry does not know this tool, which is the normal
  // answer for a Composio name -- fall through to the toolbox below.
  if (brokered) {
    await holdOpenedSession(ctx, args.stepId, brokered.output, args.lease);
    return brokered.output;
  }

  // Already gated above; do not ask again on the toolbox path either.
  if (args.forceApproval) {
    const toolbox = ctx.provider('toolbox');
    const res = await toolbox.callTool(
      { name: args.tool, args: args.toolArgs },
      ctx.callContext({ stepId: args.stepId, policyRule: 'graph-node-submit' }),
    );
    if (!res.ok) throw new Error('Tool ' + args.tool + ' failed: ' + res.error.message);
    return res.data;
  }

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

  const toolbox = ctx.provider('toolbox');
  const res = await toolbox.callTool(
    { name: args.tool, args: args.toolArgs },
    ctx.callContext({
      stepId: args.stepId,
      policyRule:
        risk.kind === UNKNOWN_TOOL_ACTION_KIND
          ? 'human-approved-unclassified-tool'
          : 'graph-node-tool-call',
    }),
  );

  if (!res.ok) throw new Error('Tool ' + args.tool + ' failed: ' + res.error.message);
  return res.data;
}

async function runTool(
  ctx: PlaybookContext,
  node: Extract<GraphNode, { type: 'tool' }>,
  scope: RefScope,
  lease: SessionLease,
): Promise<NodeResult> {
  const cfg = resolveRefs(node.config, scope);

  const result = await ctx.step(
    { label: node.label, kind: 'tool', nodeId: node.id, providerId: ctx.providerFor('toolbox') },
    async (step) =>
      callToolGated(ctx, {
        stepId: step.id,
        tool: cfg.tool,
        toolArgs: cfg.args,
        actionKind: cfg.actionKind,
        description: 'Call ' + cfg.tool,
        lease,
      }),
  );

  return { value: { tool: cfg.tool, result }, output: { tool: cfg.tool } };
}

/**
 * THE CHEAP MIDDLE RUNG. The decision layer picks one tool from the candidate
 * set and we call it directly — no agent harness, so no multi-turn model loop.
 * One cheap decide plus one tool call.
 */
async function runDispatch(
  ctx: PlaybookContext,
  node: Extract<GraphNode, { type: 'dispatch' }>,
  scope: RefScope,
  lease: SessionLease,
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

      const toolArgs = (cfg.args[tool] ?? {}) as Record<string, Json>;

      const result = await callToolGated(ctx, {
        stepId: step.id,
        tool,
        toolArgs,
        actionKind: cfg.actionKind,
        description: cfg.goal + ' (selected: ' + tool + ')',
        lease,
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
  lease: SessionLease,
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
        lease,
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

/**
 * Hold a browser session a tool call just opened.
 *
 * Recognised by shape rather than by tool name: `open` is the only browser
 * operation that returns a `sessionId` and leaves it running, and matching on
 * the payload keeps this working for any backend that does the same. Anything
 * else returns a value with no sessionId and is ignored.
 */
async function holdOpenedSession(
  ctx: PlaybookContext,
  stepId: string,
  output: unknown,
  lease?: SessionLease,
): Promise<void> {
  if (!lease || !output || typeof output !== 'object' || Array.isArray(output)) return;
  const payload = output as Record<string, unknown>;
  const sessionId = payload.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return;

  lease.hold(sessionId);

  // ANNOUNCE IT TOO. A session opened by a `tool` node is just as watchable as
  // one a handoff opened, and a later handoff that INHERITS this session has no
  // other way to tell the UI which browser it is waiting on.
  await ctx
    .announceBrowserSession({
      sessionId,
      stepId,
      providerId: ctx.providerFor('browser'),
      // Whatever the open returned is already stale by the time anyone clicks
      // it (Browserbase signs its viewer with a short-lived token), so this is
      // only a "a viewer exists" signal. The URL is minted on demand.
      interactive: typeof payload.liveViewUrl === 'string',
    })
    .catch(() => undefined);
}

/** Ten minutes. A person who has walked away, not a person who is reading. */
const HANDOFF_TIMEOUT_MS = 600_000;

/**
 * Give back every session the run is still holding.
 *
 * Best effort and never throws: a session that cannot be released is a billing
 * annoyance, while letting this reject would turn a SUCCESSFUL run into a
 * failed one at the very last moment.
 *
 * Goes through the browser CAPABILITY, so the release is ledgered by
 * withEgress like any other provider call rather than being a side channel.
 */
async function releaseHeldSessions(ctx: PlaybookContext, held: Set<string>): Promise<void> {
  if (held.size === 0) return;

  await Promise.all(
    [...held].map(async (sessionId) => {
      try {
        await ctx
          .provider('browser')
          .closeSession(sessionId, ctx.callContext({ policyRule: 'run-teardown-session-release' }));
        await ctx.releaseBrowserSession(sessionId);
      } catch (err) {
        await ctx
          .log('warn', 'Could not release browser session ' + sessionId + ': ' + String(err))
          .catch(() => undefined);
      }
    }),
  );
  held.clear();
}

/**
 * Fail the node if nobody acts in time.
 *
 * `Promise.race` and NOT an abort of the underlying approval: the approval
 * genuinely stays pending server-side, and saying otherwise in the UI would be
 * a lie. What this bounds is how long the RUN waits, which is the thing that
 * actually needs bounding. The timer is always cleared.
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
 * is deliberate: the blocking primitive (requireApproval -> waitForApproval ->
 * POST /approvals/:id/decide) is already correct, already cancellable via the
 * run's AbortSignal, and already surfaces in the UI. A second way to block a
 * run would be a second way to get cancellation wrong.
 *
 * WHY THE SESSION IS OPENED THROUGH THE CAPABILITY AND NOT THE TOOL BROKER:
 * the broker authorizes a tool call against an agent session's exposure grant
 * (see core/tools/broker.ts, assertSelected). A graph node has no such grant --
 * it is not a harness turn. The call still goes through the `browser`
 * capability, so withEgress ledgers it and the privacy story is unchanged; and
 * this node blocks for a human by construction, which is a stricter gate than
 * the `read_page` classification an open would otherwise get.
 *
 * NO CREDENTIAL PASSES THROUGH HERE. There is nothing in this function that
 * reads a secret, and `output` carries only the instruction, the session id and
 * how the wait ended. Keep it that way.
 */
async function runHandoff(
  ctx: PlaybookContext,
  node: Extract<GraphNode, { type: 'handoff' }>,
  scope: RefScope,
  lease: SessionLease,
): Promise<NodeResult> {
  const cfg = resolveRefs(node.config, scope);

  // An inherited session belongs to whoever opened it. Only a session THIS
  // node opens is one this node may hand downstream or hold for the run.
  const inherited = typeof cfg.sessionId === 'string' && cfg.sessionId.length > 0;

  const result = await ctx.step(
    { label: node.label, kind: 'handoff', nodeId: node.id, providerId: ctx.providerFor('browser') },
    async (step) => {
      let sessionId = inherited ? (cfg.sessionId as string) : undefined;

      if (!inherited) {
        const opened = await ctx
          .provider('browser')
          .openSession(
            { ...(cfg.url ? { startUrl: cfg.url } : {}) },
            ctx.callContext({ stepId: step.id, policyRule: 'handoff-open-for-human' }),
          );
        if (!opened.ok) {
          throw new Error(
            'Handoff "' +
              node.label +
              '" could not open a browser to hand over: ' +
              opened.error.message,
          );
        }
        sessionId = opened.data.sessionId;

        // Held for the REST OF THE RUN, not this step: downstream nodes inherit
        // the authenticated session. runGraph's drain is what gives it back.
        lease.hold(sessionId);

        // The person cannot reach the browser unless the viewer URL is put on
        // the run stream. Undefined liveViewUrl is NORMAL (local and mocked
        // browsers have no viewer) and the UI says so rather than dead-linking.
        await ctx.announceBrowserSession({
          sessionId,
          stepId: step.id,
          nodeId: node.id,
          providerId: ctx.providerFor('browser'),
          ...(opened.data.liveViewUrl ? { liveViewUrl: opened.data.liveViewUrl } : {}),
          interactive: opened.data.interactive === true,
          ...(cfg.url ? { startUrl: cfg.url } : {}),
        });
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
        // The PAYLOAD is what reaches the UI: the orchestrator stores
        // `action.payload ?? action`, so the discriminator has to live in here
        // or the approval panel cannot tell a handoff from an ordinary gate.
        payload: {
          kind: 'human_handoff',
          instruction: cfg.instruction,
          sessionId,
          resumeWhen: cfg.resumeWhen,
          ...(cfg.expectUrl ? { expectUrl: cfg.expectUrl } : {}),
        },
      });

      // THE TIMEOUT FAILS THE RUN. It never falls through to letting the agent
      // do it -- see handoffNodeSchema.
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
