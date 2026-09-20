# AgentOS Implementation Plan

Read [agentos-design.md](./agentos-design.md) for the source-of-truth architecture and
[jev.md](./jev.md) before changing Jev code. Jev is a typed decision model: it selects
from options AgentOS constructs; it does not generate plans, prose, tool arguments, or
tool calls.

The immediate provider work is broken into mergeable tasks in
[provider-integration-plan.md](./provider-integration-plan.md). Follow that order for the
AgentOS MCP gateway, Composio, OpenRouter, and the live email acceptance test.

## Decisions locked for the MVP

- The user starts the task in the AgentOS dashboard, not the Hermes CLI. The dashboard
  is a transparent wrapper: AgentOS creates the session, starts Hermes over ACP, and
  streams the full model/tool/Jev/approval trace back to the user.
- AgentOS owns the bounded outer loop and canonical session state. Hermes owns the inner
  reasoning/tool loop. We do not fork or reimplement Hermes.
- Before every model request, AgentOS selects the model route and filters the tool
  schemas. At every quiescent Hermes turn, AgentOS asks Jev for
  `done | continue | blocked`; verified `done` ends the run.
- OpenRouter is the cloud multi-model backend. "OpenAI-compatible" names only the wire
  protocol between Hermes and the AgentOS model gateway; it does not constrain the
  project to OpenAI models.
- Truly local/private models use a local endpoint. OpenRouter ZDR/no-training routes are
  privacy-constrained cloud routes, not local routes.
- Jev recommends semantic risk and action policy, but deterministic AgentOS policy is
  the final authority. Every tool has a baseline effect/reversibility classification,
  and every exact action is reclassified from its arguments and destination. Imported
  metadata and mapping rules avoid hand-labeling the full catalog; unknown fails closed.
- Composio credentials and execution stay behind the AgentOS MCP tool gateway. Hermes
  never receives direct authority to call Composio.
- TypeScript remains the implementation stack.

## Current implementation status — September 20, 2026

- Complete: typed Jev model/tool/risk/completion operations, local eligibility,
  candidate bounding, deterministic verification, and fail-closed fallbacks.
- Complete: AgentOS-owned session state with objective, sanitized objective, data
  labels, compact context history, context version, turn, budget, model/tool routing,
  harness session ID, latest checkpoint, and lifecycle status. It is persisted,
  returned with run detail, and emitted as `session.updated` for the UI workstream.
- Complete: bounded Hermes outer loop with same-session continuation and verified
  `done | continue | blocked` handling.
- Complete: authenticated OpenAI-compatible model gateway, per-request Jev routing,
  trusted tool-descriptor filtering, streaming responses, and a `ChatModelBackend`
  seam for the OpenRouter workstream.
- Complete: isolated Hermes profile targeting AgentOS. A live Hermes ACP run was
  observed making successful requests through `/v1/chat/completions`.
- Complete: provider-neutral trusted tool registry and exact-action broker with pinned
  descriptor versions, JSON Schema validation, confirmed-scope checks, Jev risk
  recommendation, deterministic authorization, approval pause/resume, executor
  isolation, canonical-state updates, and `tool.lifecycle` events.
- Complete: turn-scoped tool exposure grants, trusted MCP/model wire-name mapping,
  tool-result label propagation, and tool-capable route enforcement.
- Complete: authenticated stateless Streamable HTTP `/mcp` gateway, isolated Hermes
  profile injection, and one real local read executor. Hermes's own MCP probe discovers
  the tool.
- Complete: OpenRouter Chat Completions backend with explicit cheap/frontier OpenAI
  routes, trusted function-schema forwarding, tool-call validation, timeout/retry,
  token/cost egress accounting, and live credential health checks.
- Complete: Ollama local/private, tool-capable backend. The local machine is configured
  with `qwen3:8b`, and live text/tool-call probes pass without cloud egress.
- Complete: Composio v3.1 REST adapter, stable user/account isolation, OAuth link/status/
  refresh APIs, schema/version discovery, and reviewed `GMAIL_SEND_EMAIL` registration
  behind the exact-action broker. Live execution awaits Composio credentials and OAuth.
- Deliberate demo constraint: model requests are correlated to the only active Hermes
  session and fail closed if concurrent sessions are ambiguous. Add per-session gateway
  credentials before supporting concurrent users.
- Remaining integrations: configure Composio and run the real approved-email acceptance
  test; dashboard rendering and Browserbase remain team-owned.

## Milestone 1 — Fully wired Jev decision layer [P0]

This is the first priority. It must work against synthetic state before the interception
pipeline depends on it.

Person 1 — Runtime contracts

- Add shared `ModelRoute`, `ToolDescriptor`, `ToolAction`, `AuthorizationDecision`,
  `CompletionDecision`, `HarnessTurnEvent`, and canonical session-checkpoint types.
- Keep model-gateway transport separate from model-routing policy: Person 1 owns the
  transport; Person 2 owns the decision.
- Provide deterministic mock results for every contract so other tracks can work.

Person 2 — Jev, privacy, policy, completion

- Split the Jev adapter into typed operations: `select_model`, `select_tool_families`,
  `select_tools`, `recommend_action_policy`, and `judge_completion`.
- Add a local privacy/secret eligibility pass before any request reaches remote Jev.
  Send only sanitized features and summaries; raw local-only content never leaves.
- Select only from hard-policy-eligible model and tool candidates. Jev cannot invent an
  ID, expose an ineligible candidate, or grant permission.
- Implement `done | continue | blocked` over sanitized session state. Accept `done` only
  when deterministic/task-specific verification passes and no tool, approval, or output
  requirement remains.
- Add calibrated thresholds, low-confidence escalation, bounded retries, budgets, and
  fail-closed fallbacks. A Jev failure yields local/no-tools or a paused run, never the
  full catalog.
- Replace the current single averaged confidence with decision-specific confidence and
  reason codes.

Person 3 — Registry fixtures

- Implement a fixture catalog with stable IDs, families, short metadata, JSON schemas,
  baseline effect, reversibility, scopes, data labels, and executor references.
- Provide metadata search/family filtering without connecting Composio yet.

Person 4 — Event fixtures

- Define UI fixtures for every Jev decision, confidence, fallback, and completion state.
- Show that a decision is a recommendation constrained by policy, not an unqualified
  permission grant.

Checkpoint: synthetic tests prove privacy pre-filtering, candidate-bounded Jev choices,
fail-closed behavior, risk recommendation, and verified `done | continue | blocked`.

## Milestone 2 — UI wrapper and canonical outer loop [P0]

Person 1

- Make the dashboard task submission create a run and Hermes ACP session.
- Implement the bounded outer controller:
  `start Hermes turn -> collect events/results -> checkpoint session -> completion
decision -> finish, continue same session, or pause`.
- Add continuation, cancellation, timeout, and session correlation without changing
  Hermes core.
- Stream typed events through the existing SSE path.

Person 2

- Build the sanitized checkpoint view consumed by Jev and task-specific verifiers.
- Produce deterministic unmet-requirement data for a continuation; do not ask Jev to
  generate the next prompt.

Person 4

- Make the dashboard the only demo entry point: task composer, start, live status,
  pause/resume/cancel, and final result.
- Render the Hermes inner-turn lifecycle and AgentOS outer-loop checkpoints separately.

Checkpoint: entering a task in the dashboard starts Hermes, returns a response, records
canonical state, runs the completion checkpoint, and visibly ends or continues.

## Milestone 3 — Harness interception pipeline with mocks [P0]

Build and prove the control boundaries before adding live OpenRouter or Composio.

Person 1 — Model interception transport

- Add a local OpenAI-compatible `/v1/chat/completions` gateway and configure Hermes to
  use it as a custom endpoint.
- On every Hermes model request, correlate the run/session, call Person 2's routing
  policy, remove unselected tool schemas, call a mock/local model adapter, preserve
  streaming, and record actual usage.
- Never describe this protocol compatibility as an OpenAI provider dependency.

Person 2 — Per-call routing and exact-action policy

- Apply local privacy/model/tool eligibility before Jev selection on every model call.
- Implement `authorize_action` from descriptor baseline, exact arguments, destination,
  data labels, scopes, reversibility, user policy, and Jev's recommendation. The
  strictest result wins; Jev cannot downgrade it.

Person 3 — MCP tool interception

- Expose an AgentOS-owned MCP server as Hermes's tool surface.
- Validate every call against the selected descriptor/schema, construct an exact
  `ToolAction`, call `authorize_action`, and execute only on explicit allow.
- Disable Hermes native write/destructive tools for the demo. Unknown and unselected
  tools are denied. ACP permission callbacks remain a secondary gate for any retained
  native capability.

Person 4

- Show candidate versus exposed tools, selected model route, exact tool proposal,
  policy result, and all Jev decisions in real time.

Checkpoint: with mock providers, every Hermes model call passes through the model
gateway, every executable tool call passes through the MCP gate, and bypass tests fail.

## Milestone 4 — Live OpenRouter models and Composio tools [P1]

Person 1 — OpenRouter execution

- Add the live OpenRouter adapter behind the model gateway with streaming, usage,
  latency, errors, cancellation, and ordered fallbacks.
- Use an explicit catalog/allowlist rather than arbitrary Jev-produced model IDs.
- Support at least: true local/private, OpenRouter privacy-constrained cloud,
  OpenRouter cheap cloud, and OpenRouter frontier cloud.

Person 2 — Route policy

- Attach cost, capability, context-window, tool-calling, privacy, ZDR/no-training, and
  provider constraints to each eligible route.
- Demonstrate cheap-first execution and verification-driven escalation to a stronger
  eligible model.

Person 3 — Composio execution

- Implement Composio discovery, OAuth connection state, and execution behind the MCP
  gateway.
- Translate vendor names to stable AgentOS IDs at the adapter boundary.
- Start with one read-only action, one reversible write, and one externally visible or
  irreversible action. Review these demo descriptors manually; map the remaining
  catalog through conservative rules and classify unmatched tools as `unknown`.

Person 4

- Add provider/model identity, privacy route, cost, tokens, schema savings, Composio
  connection state, and truthful live/mock labels to the trace.

Checkpoint: one UI-started Hermes run uses Jev-selected OpenRouter models and
Jev-selected Composio tools while all execution remains behind AgentOS policy.

## Milestone 5 — Approval, intervention, and polished demo [P1]

- Person 1: pause/resume the outer loop and bind approval/revision to one action ID,
  descriptor version, destination, and exact payload.
- Person 2: reauthorize every revision; purchases, destructive operations, credential
  changes, and outbound messages require approval or denial regardless of Jev optimism.
- Person 3: make external writes idempotent where possible and never retry them blindly.
- Person 4: complete approve, reject, revise, pause, cancel, and completion controls in
  the live trace.

Checkpoint: the demo visibly performs an automatic read, pauses an external side effect,
supports reject and revised-payload approval, then reaches verified Jev completion.

## Milestone 6 — Evaluation and freeze [P2]

- Run the same tasks against a frontier-model/all-tools baseline and AgentOS.
- Measure task success first, then latency, input/output tokens, model calls, frontier
  calls, tool schemas exposed, estimated cost, approval count, and privacy egress.
- Test fail-closed routing, secret leakage, unselected-tool denial, exact-action binding,
  policy injection through tool output, verification-protected completion, cancellation,
  provider failure, and task success after schema filtering.
- Freeze the demo once one complete live story and its baseline comparison are reliable.

## Parallel ownership after the Milestone 1 contract checkpoint

| Owner    | Owns                                                                                                         | Does not own                   |
| -------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| Person 1 | API, canonical session state, outer controller, Hermes ACP adapter, model-gateway transport, SSE, lifecycle  | Jev policy or tool executors   |
| Person 2 | Jev operations, model/tool routing policy, privacy, risk rules, `authorize_action`, verification, completion | Gateway networking or UI       |
| Person 3 | Tool registry, MCP gateway, Composio/local executors, browser backends                                       | Permission policy or dashboard |
| Person 4 | Dashboard wrapper, live trace, approvals UX, metrics, demo fixtures                                          | Runtime and policy internals   |

The seam is deliberate: Person 1 asks Person 2 for decisions; Person 3 asks Person 2 for
authorization; Person 4 consumes events from Person 1. Each track builds against typed
mocks so independent work can begin immediately after the shared contracts land.

## MVP acceptance checklist

- [ ] A task entered in the AgentOS UI starts the Hermes loop.
- [x] Every Hermes model request passes through the AgentOS model gateway.
- [x] Jev chooses only among policy-eligible models and tool schemas on each request.
- [ ] OpenRouter provides multiple cloud model families; local inference remains a
      separate truthful route.
- [ ] Every executable tool call passes through the AgentOS MCP gateway and exact-action
      authorization before Composio/local execution.
- [x] Unknown/unselected tools and missing policy decisions fail closed.
- [ ] The UI shows models, candidate/exposed/called tools, Jev decisions, confidence,
      privacy, risk, approval, completion, latency, tokens, and cost live.
- [x] Jev returns `done | continue | blocked` from sanitized session state; only verified
      `done` ends the Hermes run.
- [ ] One side effect demonstrates approve, reject, and revised-payload paths.
- [ ] AgentOS beats the all-tools/frontier baseline without reducing task success.
