# Editable graph workflow + chat + analytics — implementation plan

> **Archived — historical planning document.** Kept for the record of how Zephyr/AgentOS
> was built during Hack the North 2026. It may describe work that has since changed; the
> current docs are the [README](../../README.md), [agentos-design.md](../agentos-design.md)
> and [DEMO.md](../DEMO.md).

Scope of this document: turning the pipeline from imperative TypeScript into an
editable graph document, driving it from a chat, visualising it live, and
measuring it against a single-prompt baseline.

It does not replace `implementation_plan.md` (the milestone/person split). It is
the build order for one vertical that cuts across Person 1 (runtime), Person 2
(metrics/baseline) and Person 4 (dashboard).

---

## 1. The problem

The pipeline today is imperative control flow — `core/playbooks/demo.playbook.ts`
_is_ the graph, encoded as `await` statements. You cannot edit control flow from
a browser.

So the first move is not "pick a graph library". It is: **make the pipeline a
document, and write one interpreter that executes it.**

The architecture already anticipates this. `PlaybookContext`
(`core/playbooks/types.ts`) is a small set of composable primitives — `step`,
`fanOut`, `requireApproval`, `runAgentTask`, `redact`, `provider`. Each graph
node type maps 1:1 onto one of them. The interpreter is therefore just another
playbook registered in `core/playbooks/registry.ts`, and nothing above that
layer changes.

## 2. Target flow

```
chat message ──▶ synthesised graph ──▶ user reviews / edits on canvas ──▶ run
                        ▲                                                 │
                        └────────── later: "add a retry after node 3" ◀───┘
                                                                          │
                                          live node highlighting  ◀───────┘
                                          + per-node token/time rollup
```

Note the chat **synthesises a graph; it does not launch a run.** That ordering is
the product.

---

## 3. Architectural decisions

### 3.1 The graph document

`packages/shared/src/schemas/graph.ts` — **zod is the source of truth and the
TypeScript types are inferred**, so the validator guarding the API boundary can
never drift from the types the editor codes against. There is deliberately no
separate `graph.ts`. Additive only, per the rule at the top of `domain.ts`.

```
GraphNode  = { id, type, label, position: {x,y}, background?, config }
GraphEdge  = { id, source, target, sourceHandle? }   // sourceHandle = decision branch
AgentGraph = { id, name, description?, nodes, edges, version,
               createdAt, updatedAt, assertions? }
```

`GraphNode.type` uses the **same vocabulary as `StepSpec.kind`**, which buys the
icon map in `components/runs/StepRow.tsx` for free in the editor:

| type         | LLM?   | maps to                                     |
| ------------ | ------ | ------------------------------------------- |
| `fetch`      | no     | `ctx.step` — load a source                  |
| `tool`       | **no** | `ctx.step` + `provider('toolbox').callTool` |
| `redact`     | no     | `ctx.redact`                                |
| `decide`     | yes    | `provider('text.model').complete`           |
| `agent_task` | yes    | `ctx.runAgentTask`                          |
| `swarm`      | either | `ctx.fanOut`                                |
| `judge`      | yes    | `provider('decision').decide`               |
| `submit`     | no     | `callTool` **behind** `ctx.requireApproval` |
| `approval`   | no     | `ctx.requireApproval` standalone            |

**`tool` is first class: a deterministic tool call with no model in the loop.**
Distinct from `submit` (same call, approval-gated because it is irreversible)
and from `agent_task` (a model chooses the tools). It contributes zero tokens
and zero `llmCalls`, which is exactly the argument for a graph over one large
prompt — and it keeps the `llmCalls` heuristic in §3.6 honest for free.

`config` is a **discriminated union keyed on `type`**. This is what stops the
editor being an arbitrary-code-execution surface — the interpreter only ever
reads validated, typed config. `agentGraphSchema.superRefine` additionally
rejects duplicate node ids, edges pointing at missing nodes, and cycles;
`findGraphCycle` is exported so the interpreter and editor share one answer.

### 3.2 `Step.nodeId` — the whole visualisation story, in one field

Add `nodeId?: string` to `Step` and `StepSpec`; thread it through `createStep`
in `core/orchestrator.ts`.

`step.upserted` already streams the full `Step` over SSE and the reducer in
`hooks/useRunStream.ts` already accumulates them, so live node highlighting
becomes `steps.find(s => s.nodeId === node.id)?.status`. **No new event type, no
new SSE plumbing.** The same field is the join key for per-node analytics
(§3.6). Land it first; everything downstream depends on it.

### 3.3 Execute nodes as a promise map, not a topological walk

Keep `Map<nodeId, Promise<output>>`; each node awaits its predecessors'
promises. Same code volume as a sequential walk, and three things fall out free:

- independent branches run concurrently
- a "background" node is simply a node nothing awaits
- `{{node_3.output.summary}}` templating has an obvious resolution point

That single choice covers "an agent that runs a tool in the background and sends
its output somewhere else".

**Reject cycles at save time** (zod `.refine`, or a check in the POST handler).
A cyclic graph hangs the interpreter, and a hung run mid-demo is worse than a
rejected save.

**Snapshot the graph into the run at start** — store it alongside `graphId` in
`run.input`. Otherwise editing a graph retroactively corrupts what an earlier
run's page displays.

### 3.4 Chat: one conversational endpoint from day 1

```
POST /api/conversations/:id/messages  { text }
  → { message, graph }        // always the full graph
```

v1 passes `currentGraph: null` internally. Conversational editing later passes
`currentGraph: <the graph>`. Same endpoint, same prompt template, same response
shape. **Do not build a `createGraph` endpoint that has to be replaced later.**

Emit the **whole graph**, not edit-ops — far easier to prompt and validate at
~10 nodes, and it avoids a partial-apply layer. Preserve `position` for
surviving node ids and auto-layout only new ones (~15 lines), so an edit does
not scramble the canvas.

Synthesis happens **outside a run**, but `recordEgress` in `services/runtime.ts`
keys every provider call on a `runId`. Use the **conversation id as the egress
key**, prefixed `conv_` so it cannot collide with `run_`. The synthesis call
then lands in the same ledger as everything else, which is the claim we want to
be able to make anyway.

### 3.5 Mock-first, identical when live

The rule: synthesis goes through `providers.provider('text.model')`, never a
direct SDK call.

The one place mocking needs real thought: **the anthropic mock must return a
valid graph JSON**, not a generic stub. Have it return one of 2–3 canned graphs
by keyword match on the prompt. Deterministic means rehearsable, and it means
the entire chat → graph → run loop works with zero API keys.

Node tool pickers are already mock/live symmetric: `ToolboxAdapter.listTools`
exists and is implemented in the composio mock. Expose it as `GET /api/tools`
and delete the hardcoded `CANDIDATE_TOOLS` array in `demo.playbook.ts`.

### 3.6 Analytics

**Most of the plumbing already exists.** `ProviderMeta` carries
`latencyMs / tokensIn / tokensOut / estimatedCostCents`; `withEgress` forwards
them onto every `EgressEvent` automatically; `EgressEvent.stepId` links a cost
row to a step; `Step.nodeId` (§3.2) links a step to a node. Per-node rollup is
therefore a **pure derivation over data already flowing** — no new storage, no
new events.

Put the types _and_ the rollup function in `packages/shared/src/analytics.ts`:

```
NodeMetrics  = { nodeId, label?, stepIds[], status, wallMs, providerLatencyMs,
                 llmCalls, tokensIn, tokensOut, estimatedCostCents,
                 toolsAvailable?, toolsExposed?, toolCallsActual?, modelTier? }

RunAnalytics = { runId, kind, status, nodes: NodeMetrics[], unattributed, totals }

rollup({ run, steps, egress, scheduleDecisions, approvals }, now?) => RunAnalytics
```

`unattributed` collects steps with no `nodeId` — every step of a hand-written
playbook like `demo` — so totals always reconcile against the ledger instead of
silently dropping work. `now` is injectable so a running run reports a live
`wallMs` while tests stay deterministic.

Shared is already browser-bundled and forbids Node built-ins, so **one
implementation serves both**: the API serves it at
`GET /api/runs/:id/analytics` for completed runs, and the web app runs the same
function client-side over the `RunView` the reducer already builds, for live
numbers. Model it on `summarise()` in `core/ledger.ts`, which is already pure
and already computes run-level totals.

**Wall-clock vs. summed provider latency is a headline number.** With the
promise-map executor, independent nodes overlap, so
`sum(node.providerLatencyMs) / totals.wallMs` is a real parallelism factor:
_"7 nodes, 12.4s of model time, 4.1s wall clock — 3.0× from the swarm."_

#### Known gap to fix first

The anthropic mock returns `tokensIn`/`tokensOut` in its **data** but never
passes the `cost` argument to `mockCall`, so `ProviderMeta` carries no tokens,
so the egress ledger records none, so `summarise()` reports **zero tokens for
the most important provider**. The hermes mock does it correctly — copy that.
The jev mock has the same gap and matters too, since `decision` is an LLM call
in reality. ~4 lines total, and without it the analytics dashboard silently
reads zero in mock mode.

### 3.7 The baseline comparison

The thesis is "orchestrated LLM tools beat a single chat prompt". That needs an
actual baseline to compare against.

**Make the baseline a `Run` with `kind: 'baseline'`** — same goal, one
`text.model.complete` call at `tier: 'frontier'`, no tools, no graph. Because it
is an ordinary run, it gets steps, egress rows, tokens, timing and the analytics
endpoint _for free_, and it is comparable to a graph run by construction. Then
`GET /api/runs/:id/comparison?baseline=<runId>` is a diff of two `RunAnalytics`.

This lines up with work already scheduled in `implementation_plan.md` —
Milestone 2 Person 4 ("baseline comparison") and Milestone 4 Person 2
("Baseline vs. AgentOS", "percentage improvements").

#### Be honest about what the numbers will say

A single frontier prompt will be **cheaper and faster than the graph almost by
definition**. If the dashboard only shows tokens, cost and latency, it argues
_against_ the product.

The graph wins on correctness, verifiability and auditability — so the
comparison needs a **success axis**, not just a cost axis. Add optional
`assertions` to `AgentGraph` (`{ check, expected }[]`) evaluated at the end of a
run and recorded on `RunAnalytics`. Then the comparison reads:

> baseline: 1 call, 800 tokens, 2.1s, **assertions 1/4 passed**
> graph: 9 calls, 4 200 tokens, 4.1s, **assertions 4/4 passed**, 1 approval gate,
> 50 tools → 6 exposed

That is the argument. Cost alone is not.

---

## 4. Constraints found in the current code

Three things that are already true and that this plan has to design around.

**Hermes does not enforce the tool list.** `providers/hermes/live.ts` is
explicit: `_meta.enabled_toolsets` is best-effort and empirically did _not_
change Hermes's own `tool_search` kept-count. A node that says "this agent has 3
tools" is therefore advisory under live Hermes, not a guarantee.

Turn it into a feature rather than hiding it: the post-hoc audit in
`core/orchestrator.ts` already records what Hermes actually called, so diff
actual-vs-exposed and render a divergence badge on the node. The honest claim
becomes _"Jev narrowed 50 tools to 6 before the harness started, and we detect
when the harness exceeds that"_ — true, and provable from the `ScheduleDecision`.

**Hermes permission requests are auto-denied.** Also `hermes/live.ts`: the ACP
permission callback is denied by default rather than routed to our approval
gate. A background-agent node will hit this the moment it touches a real tool.
The file itself calls the fix — route the callback through `core/risk.ts`
`classify()` and, on `ask_human`, the real `waitForApproval` flow — "the next
real step, not a nice-to-have". Treat it as scheduled work.

**Harness is swappable in schema only.** Put `harness?: ProviderId` in the agent
node config and validate it against providers declaring the `agent.runtime`
capability, but have the interpreter accept only `hermes` for now. Costs
nothing, demonstrates the abstraction, and commits us to no second adapter —
there is not enough time to bring one up late.

**Hermes reports no token usage — confirmed against a live session.** `meta()` in
`providers/hermes/live.ts` carries no token fields, so a live `agent_task` node
contributes **zero** to every cost and token number. Verified empirically by
`scripts/live-check.mjs` against a real ACP session: eleven hermes ledger rows,
zero tokens, while the same run's live Anthropic call reported 62 in / 214 out.

This is a real blind spot in the ledger, not a cosmetic gap, and it biases the
Phase 5 baseline comparison in the graph's favour — agent work looks free. Two
things follow: the UI must render it as an explicit "not reported" rather than a
silent `0`, and someone should check whether ACP surfaces usage at all before we
claim a total cost number on stage. Note it next to the two limits above, which
come from `hermes/live.ts`'s own header comment.

---

## 5. Build order

### Phase 0 — contract — **DONE**

1. `Step.nodeId?` on `Step`, `StepSpec`, `FanOutSpec`, `AgentTaskSpec`, threaded
   through `createStep` (a swarm's parent and children share one nodeId)
2. `shared/schemas/graph.ts` — zod is the source of truth, types inferred; nine
   node types including a no-LLM `tool` node; refinements reject duplicate ids,
   dangling edges and cycles
3. `shared/analytics.ts` — `NodeMetrics`, `RunTotals`, `RunAnalytics`, pure
   `rollup()`; `summarise()` moved here from `core/ledger.ts`, which re-exports it
4. Cost-reporting fixes in `anthropic/live.ts` (the important one — real
   `message.usage` never reached `meta`), plus the anthropic and jev mocks
5. `GET /api/tools` (60s cache) and `GET /api/runs/:id/analytics`
6. `runReducer` now handles `schedule.decided`, which it previously dropped

Verified by `pnpm check:graph` (15 schema checks), `pnpm smoke` in forced-mock
mode (40 checks), and `pnpm smoke:live` against live Anthropic + Hermes.

**Graph persistence and node/edge CRUD were deliberately deferred to Phase 1**
so Phase 0 did not block the team for half a day.

### Phase 1 — the loop, headless (~4h) — highest risk, front-load it

6. Store methods (`saveGraph`/`getGraph`/`listGraphs`/`deleteGraph`) + `graphs` in
   the `memory.ts` snapshot + `api/graphs.routes.ts`, including node/edge-level
   add, update and remove. Every granular endpoint must go through ONE
   whole-graph validate-and-save helper (`mutateGraph(id, fn)`) so node edits
   cannot bypass the cycle/reference checks; deleting a node cascades to its
   edges; `PUT`/`PATCH` take a `version` and return 409 on mismatch, because
   chat and the canvas will both write to the same graph
7. `core/graph/interpreter.ts` — promise-per-node, `{{ref}}` resolution
8. `core/playbooks/graph.playbook.ts` + one line in `registry.ts`
9. Port `demo.playbook.ts` into a seeded `demo.graph.json`

> **Checkpoint:** curl a graph in, run it, watch the _existing_ `StepTimeline`
> fill in. No new UI. If this does not work, nothing downstream matters.

### Phase 2 — see it (~3h)

10. React Flow canvas, read-only render
11. `<RunGraph>` on `RunDetail`, driven by `nodeId` → `step.status`
12. Per-node token/time badges from the shared `rollup()`

> Demo-able here: seeded graph, lighting up live, with numbers on it.

### Phase 3 — chat (~3h) — the stated target lands at the end of this

13. Conversation service + synthesis via `text.model`, canned mock graphs
14. Chat panel; generated graph renders on the canvas with Run / Edit

### Phase 4 — edit (~3h)

15. Node inspector: tool multi-select from `/api/tools`, harness field, background flag
16. Drag / connect / delete / save

### Phase 5 — baseline + comparison (~2h)

17. `kind: 'baseline'` playbook, `assertions` on `AgentGraph`
18. Comparison view — the Baseline vs. AgentOS panel

### Phase 6 — conversational edit (~1.5h, near-free if Phase 3 was built right)

19. Pass `currentGraph` into the same endpoint + position preservation

### Phase 7 — Hermes reality (size when you get here)

20. ACP permission → `classify()` → `waitForApproval`
21. Tool divergence badge from the post-hoc audit

---

## 6. Parallelisation and fallbacks

Phases 0–1 unblock parallel work: one person on 6–9, another on 10–12 against a
hand-written fixture graph, a third on 17–18 (the baseline run needs only the
existing `text.model` capability and `rollup()`).

**Keep `kind: 'demo'` registered alongside `kind: 'graph'` the entire time.** It
is the fallback run that always works on stage.

The least trustworthy estimate is the interpreter (#7). If it is not converging
in ~3h, fall back to rendering the graph read-only _from_ the steps the existing
`demo` playbook already emits — you keep the canvas, the live visualisation, the
analytics and the chat, and lose only execution-from-graph.

Per the standing rule: no new dependency after hour 30. **React Flow
(`@xyflow/react`) goes in during Phase 2 or not at all.**
