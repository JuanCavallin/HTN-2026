# AgentOS — Final Design Specification

## Product

**AgentOS is a harness-agnostic control plane that makes AI agents faster, cheaper,
more private, and easier to supervise.** A thin adapter connects a harness to AgentOS;
Hermes is the first adapter and the hackathon demo.

For each agent step, AgentOS uses Jev to recommend the model route, relevant tools,
context scope, action risk, and whether the overall task is complete. Deterministic
AgentOS policy remains the final authority for privacy, permissions, verification, and
external side effects.

The user starts and supervises a run from the AgentOS dashboard. AgentOS owns the outer
control loop and canonical session state; its Hermes adapter starts and resumes Hermes's
inner agent loop over ACP. AgentOS does not fork or reimplement the harness. Reusing the
product with another harness means translating that harness's model, tool, and lifecycle
boundaries into the same contracts.

## MVP Boundary

The MVP proves the complete flow with Hermes. Supporting another harness later means
implementing the same adapter contract; a universal “connect any harness” UI is not a
hackathon requirement.

Included: one Hermes adapter, Jev with a deterministic fallback, local/private and cloud
model routes, 2–3 live providers, a 50+ tool catalog containing clearly labeled fixtures,
one complete demo playbook, real-time intervention, and measured evaluation.

Excluded: a replacement inner agent loop, multiple production harness adapters, a plugin
marketplace, enterprise RBAC, production secret management, learned policies,
distributed execution, and cloud deployment.

## Architecture

```text
Dashboard (start, observe, intervene)
        ↕ HTTP + SSE
AgentOS API + Outer Run Controller ↔ Canonical Session State ↔ Trace/Metrics
        │                                      ↑
        └─ Hermes ACP Adapter ↔ Hermes Inner Agent Loop
                                  │
                                  ├─ model request → AgentOS Model Gateway
                                  │                   ├─ local privacy/policy eligibility
                                  │                   ├─ Jev model + tool selection
                                  │                   └─ OpenRouter or local model
                                  │
                                  └─ tool call → AgentOS MCP Tool Gateway
                                                      ├─ exact-action policy/approval
                                                      └─ Composio or local executor
```

| Component                | Responsibility                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API and outer controller | Starts Hermes runs from the dashboard; handles continuation, completion, pause/resume, cancellation, approvals, revisions, and SSE events                  |
| Session state            | Objective, plan, messages, artifacts, tool results, labels, decisions, and progress                                                                        |
| Jev                      | Recommends routing, risk, next-step intent, and task completion                                                                                            |
| Model gateway            | Accepts Hermes's OpenAI-compatible wire format, filters the per-call tool schemas, selects an approved model, and records usage, cost, latency, and errors |
| Context builder          | Produces minimal context while preserving provenance and sensitivity labels                                                                                |
| Tool registry            | Normalizes tools and exposes only eligible metadata, schemas, and executors                                                                                |
| Policy gate              | Enforces privacy, permissions, risk, approval, and exact-action authorization                                                                              |
| Harness adapter          | Starts/resumes the Hermes inner loop and translates lifecycle events without leaking harness types into AgentOS core                                       |
| Dashboard                | Collects the user's task, starts the wrapped Hermes run, shows the entire live trace, and supports intervention                                            |

## Step Lifecycle

1. The user submits a task in the dashboard; AgentOS creates the canonical session and
   starts a Hermes ACP session.
2. Before each Hermes model call, build the smallest useful context packet and locally
   filter ineligible models and tools using hard privacy and permission rules.
3. Ask Jev for a model route, tool subset, context scope, and provisional action policy.
4. Constrain Jev's recommendation with deterministic policy and budget limits, then send
   only approved context and tool schemas to the selected model.
5. If the model proposes a tool, authorize its exact arguments, destination, and data
   before the AgentOS MCP gateway executes it through Composio or a local executor.
6. Record the route, context, policy, tools, latency, tokens, cost, and outcome.
7. When the Hermes inner turn is quiescent, verify the result and ask Jev for
   `done`, `continue`, or `blocked` from the sanitized session state.
8. On verified `done`, close the run. On `continue`, send the unmet-requirement packet
   into the same Hermes session for another bounded turn. On `blocked`, pause for the
   user. Stream every decision to the dashboard.

## Core Contracts

### Model routing

Cost and privacy are separate. A `ModelRoute` identifies:

| Field          | Values                               |
| -------------- | ------------------------------------ |
| `costTier`     | `cheap` or `frontier`                |
| `deployment`   | `local` or `cloud`                   |
| `contextScope` | `public`, `private`, or `local_only` |
| Identity       | `providerId` and `modelId`           |

The demo therefore supports local/private, privacy-constrained cloud, cloud/cheap, and
cloud/frontier routes. OpenRouter is the cloud model catalog and gateway; it supplies a
mixture of vendors and model families rather than implying use of OpenAI models. Hermes
speaks an OpenAI-compatible request format to AgentOS only as a wire protocol.

Truly local/private inference goes directly to an approved local endpoint such as
Ollama or vLLM. An OpenRouter route may require zero-data-retention, no-training, or a
provider allowlist, but it is still cloud egress and must never be labeled local. A
`local_only` step may never silently escalate to OpenRouter or another cloud provider.

A `ScheduleDecision` contains the selected route, selected tool IDs, context scope,
provisional action policy (`auto`, `verify`, `ask_user`, or `deny`), confidence, and
typed reason codes. Jev receives sanitized session summaries and short tool metadata,
not credential values, raw secrets, or every full schema.

### What Jev is

Jev is TypeSafe AI's _System One_ decision model, reached through the `typesafe-sdk`
package or `POST https://api.typesafe.ai/v1/systemone` with model id `jev-latest`.

It answers **typed questions against state** and returns a `Choice` (one key from a
supplied `criteria` set), a `Score` (a float against an ordered scale), or a `Noul` (a
probability that a proposition holds). Every answer carries calibrated confidence and a
probability distribution, and many questions may be batched into one request.

**Jev does not generate text and has no tool access or agent loop.** It selects among
options the caller constructs. Anything generative — a plan, a payload, text to type into
a field — comes from a normal model, with Jev choosing between the candidates produced.

Two consequences for this design:

- The confidence thresholds this document relies on are directly implementable, because
  Jev returns calibrated probabilities rather than self-reported certainty.
- Jev is inherently a quarantined reader: a model that can only return an index into a
  caller-built list cannot be induced by untrusted page or tool content to issue an
  action. This constrains injection; it does not replace the policy gate.

Operational detail, browser usage and anti-patterns: [jev.md](./jev.md).

### Jev completion decision

After each quiescent Hermes inner turn and any other meaningful checkpoint, AgentOS asks
Jev whether the objective has been satisfied. The request contains a policy-eligible
view of session state:

- Objective, plan, and completed or failed steps.
- Structured artifact and tool-result summaries.
- Verification results and outstanding requirements or approvals.
- Remaining step, time, token, and cost budgets.

Jev returns `done`, `continue`, or `blocked`, plus confidence, reason codes, missing
requirements, and an optional suggested next step.

This decision controls the outer loop but is not the sole proof of completion. AgentOS
accepts `done` only when required output schemas and task-specific checks pass, no
required tool call, approval, or verification remains, policy permits the result, and
Jev clears the configured confidence threshold. AgentOS then closes/cancels the Hermes
session as appropriate and emits `task.completed`. Low confidence or failed verification
causes a bounded continuation or escalation in the same Hermes session. Step and budget
limits prevent endless loops. `blocked` pauses for a user or records a terminal
explanation.

If Jev is remote, local-only state is never sent to it; AgentOS uses a sanitized summary
or a deterministic/local completion check instead.

### Tools, actions, and events

`ToolDescriptor` records a stable ID, provider, family, description, schema reference,
transport, baseline effect (`read`, `write`, `destructive`, or `unknown`),
reversibility, required scopes, allowed data labels, credential reference, availability,
and executor reference. Credentials and full schemas remain local. Provider metadata and
mapping rules may populate these fields; the team does not need to hand-label every
imported tool, but an unknown classification fails closed and demo tools are reviewed.

`ToolAction` records the run, step, action, tool, exact arguments, destination, data
labels, and descriptor version. Schema hiding is an optimization, not authorization:
AgentOS rechecks the actual action immediately before execution.

Jev may recommend the action policy (`auto`, `verify`, `ask_user`, or `deny`) and flag
semantic risk that static metadata missed. It cannot be the sole permission authority or
downgrade the descriptor/policy baseline: its output is probabilistic, and the risk of a
tool changes with its exact arguments and destination. Deterministic rules combine the
descriptor baseline, exact action, data labels, scopes, reversibility, user policy, and
Jev recommendation. The strictest applicable result wins.

Every boundary emits a typed event containing route and Jev reasoning, tools considered,
exposed and called, context labels, policy and verification results, completion status,
usage, latency, and estimated cost.

## Human Intervention

For a gated action, the user can approve the exact payload, reject it, revise allowed
arguments, pause, or cancel. Approval/revision is bound to one action ID, descriptor
version, destination, and payload. AgentOS reauthorizes any revision and records both
the proposed and final action.

## Safety and Privacy Invariants

- Deterministic policy overrides Jev and the harness.
- Routing, completion, and policy failures fail closed; failure never exposes all tools.
- Purchases, destructive operations, credential changes, and outbound messages require
  exact-action approval or denial.
- Irreversible tools never enter an unattended harness allowlist. The harness may
  propose them; AgentOS performs them only after its own gate.
- Public, private, and secret labels propagate through summaries and derived artifacts.
- Local-only data never goes to a cloud model, remote Jev, Browserbase, or remote tool.
- Tool descriptions and outputs are untrusted and cannot grant permission.
- External writes are never retried blindly.
- The demo uses synthetic customer and payment data only.

## Dashboard

The UI is the user's entry point and wrapper around the Hermes run. It shows the task
composer, start/pause/resume/cancel controls, connected harness and provider health;
current plan and step; candidate,
exposed, and called tools; model route and escalation history; Jev scheduling and
completion decisions; context labels and egress; pending approvals/revisions; and
latency, tokens, cost, frontier calls, schema-token savings, and success. Live providers,
mocks, fixtures, cached replay, and real execution must be labeled truthfully.

## Demo

A support-operations user asks AgentOS to analyze a synthetic private customer file,
research high-risk companies on the public web, produce an account brief, and request
approval before outreach.

1. Private data is labeled and processed locally.
2. Jev selects a cheap cloud route and only public browser research tools.
3. A difficult synthesis fails verification and escalates to an eligible frontier model.
4. Jev reviews sanitized session state and recommends `continue` or `done`.
5. An outbound message pauses for approval or revision of its exact payload.
6. The dashboard proves success, tool reduction, privacy enforcement, completion
   reasoning, frontier calls avoided, and measured savings.

## Acceptance Criteria

| Capability    | Requirement                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness       | A task submitted in the AgentOS UI starts and completes one Hermes run without modifying Hermes core                                                        |
| Tools         | 50+ registered/simulated schemas reduce to 3–8; unknown or unselected calls are blocked                                                                     |
| Models        | OpenRouter supplies multiple cloud model families, a separate true local route remains available, and one run demonstrates a verification-driven escalation |
| Context       | One canonical state supports model switching while preserving labels and provenance                                                                         |
| Completion    | At each outer-loop checkpoint Jev returns `done`, `continue`, or `blocked`; verified `done` stops the Hermes run and failed verification continues it       |
| Safety        | One side effect demonstrates approve, reject, and revised-payload paths with reauthorization                                                                |
| Observability | The live UI shows routes, Jev reasoning, completion, tools, privacy, risk, latency, tokens, and cost                                                        |
| Evaluation    | The same task runs against a frontier-model/all-tools baseline; savings count only when both succeed                                                        |

Required tests cover fail-closed routing, unavailable/unselected tools, exact-action
approval, revised-action authorization, secret leakage, policy injection through tool
output, verification-protected completion, and task success after schema filtering.

## Team Work Split

Agree `ScheduleDecision`, `ToolDescriptor`, `ToolAction`, the event schema, and mock
responses first. Each owner then builds against those contracts so all four tracks
progress in parallel.

| Owner    | Scope                                  | Components owned                                                         | Deliverables                                                                                                                                                                                                                                                                                                                                                               | Integration contract                                                                                     |
| -------- | -------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Person 1 | Core runtime and harness               | API, session state, outer controller, harness adapter, gateway transport | Run API; Hermes adapter and compatibility spike; model/tool interception transport; SSE; pause/resume/cancel; approval and revision endpoints; context persistence plumbing                                                                                                                                                                                                | Consumes `ScheduleDecision`; emits events and proposed `ToolAction`                                      |
| Person 2 | Jev, model routing, safety and privacy | Jev scheduler and completion judge, context builder, policy gate         | Jev schemas and deterministic fallback; hierarchical selection; tier and route selection; context ranking; bounded escalation; completion decision and verification gating; baseline evaluation; privacy labeling and secret handling; hard risk rules; exact-action authorization, revision reauthorization and approval enforcement; leakage and permission-bypass tests | Implements `schedule(state)` with a deterministic mock fallback, `build_context`, and `authorize_action` |
| Person 3 | Tools and browser                      | Tool registry, MCP gateway, executors, browser                           | MCP setup; `ToolDescriptor` registry; plugin manifests; tool metadata search; browser adapter and Browserbase integration, including a local-browser path; tool execution; simulated tool fixtures, clearly labeled non-executable                                                                                                                                         | Implements `select_tool_metadata`; executes tools through each descriptor's executor reference           |
| Person 4 | Dashboard, metrics and demo            | Dashboard                                                                | UI task entry and Hermes-run wrapper; live trace; approval, revision, pause and cancel controls; provider and tool counts; cost and token metrics; synthetic demo fixtures; live/mock/fixture/replay labeling; presentation                                                                                                                                                | Consumes the event stream; calls approve, reject, revise, pause and cancel endpoints                     |

Person 3's scope is split across two people — **3A (tool registry and MCP)** and
**3B (browser and Browserbase)**. See [person-3.md](./person-3.md) for that breakdown,
the seam between the two tracks, and the files each one owns.

### Handoffs

- **Authorization before execution.** Person 3's executor calls Person 2's
  `authorize_action` with the exact `ToolAction` before every run and executes only on
  an allow. A failed or missing check blocks execution.
- **Tool selection.** Jev (Person 2) chooses tool families and the final set. Person 3's
  `select_tool_metadata` retrieves candidates within the chosen families from the
  registry.
- **Browser destination.** Person 2's policy decides whether a step may use Browserbase.
  Local-only data never goes there, per the safety invariants. Person 3 implements both
  Browserbase and the local-browser path and uses whichever policy allows. If policy
  allows neither, the step is blocked.
- **Approvals.** Person 1 owns pause/resume and the approval endpoints. Person 2
  authorizes each action and reauthorizes any revision. Person 4 renders the controls.

### Required test ownership

| Owner    | Tests                                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Person 1 | Run reliability; pause/resume and cancellation                                                                                                                    |
| Person 2 | Fail-closed routing; exact-action approval; revised-action authorization; secret leakage; policy injection through tool output; verification-protected completion |
| Person 3 | Unavailable and unselected tools blocked; task success after schema filtering; browser and tool reliability                                                       |
| Person 4 | Metrics accuracy; error and empty states; truthful live/mock/replay labels                                                                                        |

## Pitch

**AgentOS gives every agent step the cheapest safe model, the smallest useful context,
and only the tools it needs—while keeping every decision visible, verifiable, and under
human control.**
