# AgentOS Hackathon Design Document

_Working design for a framework agnostic control plane for AI agents_

**Decision.** AgentOS will be a standalone middleware and policy layer, not a fork of Hermes. Hermes is the first execution-harness adapter; the core scheduler, context store, policy engine, telemetry, and model gateway remain harness agnostic.

## Problem and Product Goal

Current agents often send every step to an expensive model, expose too many tool schemas, mix sensitive and public context, and execute side effects through opaque rules. AgentOS makes each step cheaper, faster, safer, and easier to inspect by deciding what intelligence and permissions that step actually needs.

### MVP Goals

- Route each model call to a local, cheap, or frontier tier and escalate when confidence or verification fails.
- Expose only the relevant browser, MCP, filesystem, or shell tools for the current step.
- Build the smallest useful context packet from central state while enforcing public, private, and secret labels.
- Gate tool actions through deterministic policy plus Jev risk classification and human approval.
- Stream a complete trace of routing decisions, latency, tokens, cost, tool exposure, and approvals.

### Non Goals for the Hackathon

No custom agent loop, cloud migration, production secret manager, learned routing policy, distributed execution, enterprise RBAC, or multi-harness support beyond a clean adapter contract.

## System Architecture

```
Client and Dashboard → AgentOS API and Context Store → Harness Adapter → Agent Loop
Scheduler and Model Gateway ↔ Tool Registry and Browser ↔ Policy Gate → Execution
All boundaries emit events to the Trace Store and Metrics UI
```

| Component | Responsibility | MVP implementation |
| --- | --- | --- |
| AgentOS API | Owns sessions, run control, approvals, and event streaming. | FastAPI with SSE or WebSocket events |
| Harness adapter | Normalizes model and tool boundaries without owning the loop. | Hermes plugin or middleware adapter |
| Jev scheduler | Returns typed decisions for model, tools, context, and action policy. | One route function with fixed schema |
| Model gateway | Maps tiers to providers and records cost, latency, and failures. | Local plus cheap cloud plus frontier |
| Context manager | Builds the minimum step context from canonical session state. | SQLite with labeled message and artifact records |
| Tool registry | Indexes tool metadata and exposes only selected schemas. | MCP, browser and native tools; 2–3 live providers first |
| Policy gate and trace | Enforces privacy and risk rules, approvals, and tracing. | Fail closed gate plus React timeline and metrics |

## Runtime Contracts

### Scheduler Input

The scheduler receives the current objective, step summary, candidate models, candidate tool metadata, privacy labels, remaining budget, recent failures, and hard policy constraints. Raw secrets never need to be sent to Jev.

### Scheduler Output

| Field | Allowed values | Meaning |
| --- | --- | --- |
| model_tier | local \| cheap \| frontier | Model class for this step |
| tool_ids | List of registry IDs | Only schemas exposed to the reasoning model |
| context_scope | public \| private \| local_only | Maximum data scope allowed |
| action_policy | auto \| verify \| ask_user \| deny | Required gate before execution |
| confidence | 0.0 to 1.0 | Supports escalation and review thresholds |
| reason_codes | Typed list | Short explanations for the trace UI |

### Step Lifecycle

1. **Build state.** The context manager creates a minimal, labeled step packet from the canonical run state.
2. **Schedule.** Jev selects a model tier, tool subset, context scope, and provisional action policy.
3. **Enforce.** Deterministic privacy and budget rules constrain or override the proposed route.
4. **Reason.** The harness calls the selected model with only approved context and tool schemas.
5. **Gate.** Any proposed tool call passes hard policy, Jev risk scoring, and approval rules.
6. **Execute and observe.** The tool runs, results return to central state, and all timing, cost, and outcomes are traced.
7. **Escalate.** Failed verification or routing uncertainty triggers a bounded retry on a stronger policy-eligible model; if none is allowed, pause or stop.

## Safety and Privacy Rules

- Deterministic policy always wins over Jev. Purchases, destructive actions, credential changes, and outbound messages require explicit approval or denial.
- A local preprocessor detects secrets and assigns public, private, or secret labels before any cloud request is constructed.
- Use secret references, resolve only for authorized destinations, and redact results and traces. The demo resolver is not a production secret manager.
- The policy gate fails closed. If routing or policy evaluation errors, the action does not execute and sensitive context does not leave its allowed scope.
- The demo uses synthetic customer and payment data only.

## Browser and Tool Routing

The browser is one tool family, backed by Browserbase or the harness browser stack. Jev first selects a family, then a small set of concrete tools such as search, open, extract, click, and submit. Read-only actions can auto-execute; form submission and other external side effects pass through the policy gate.

All browser actions run through Browserbase, and Jev executes them directly rather than handing them to a separate local, cheap, or frontier model, because Jev is faster. This removes an extra model call from each browser step and keeps browsing latency low.

## MVP Scope and Acceptance Criteria

| Capability | MVP acceptance criterion |
| --- | --- |
| Harness integration | One Hermes run completes through the AgentOS adapter without modifying Hermes core. |
| Model routing | A single run visibly uses at least two tiers; low confidence triggers one real escalation. |
| Tool routing | At least 50 registered or simulated schemas collapse to 3 to 8 relevant tools per step. |
| Context | Private input remains local or sanitized; public research may use a cloud model. |
| Browser | The agent searches, opens, and extracts live public information. |
| Risk gate | One external side effect pauses for approve or reject and resumes correctly. |
| Observability | The dashboard shows step route, confidence, tools, privacy, risk, latency, tokens, and cost. |
| Evaluation | The same scripted task runs against a frontier-for-everything baseline and reports success plus efficiency metrics. |

## Demo Story

A support-operations user asks AgentOS to analyze a synthetic private customer file, research the highest-risk companies on the public web, draft an account brief, and request approval before sending any outreach.

1. **Private analysis.** The file is labeled private and parsed locally.
2. **Efficient research.** Jev selects a cheap model and exposes only browser search, open, and extract tools.
3. **Adaptive reasoning.** A difficult synthesis step falls below the confidence threshold and escalates to the frontier tier.
4. **Safe action.** The agent drafts an outbound message but pauses at the policy gate for human approval.
5. **Visible proof.** The dashboard reports task success, route decisions, cost saved, frontier calls avoided, and tool-context reduction.

## Success Metrics

Measure task success, latency, total cost including Jev and verification, frontier calls avoided, schema tokens saved, and safety outcomes against a comparable measured baseline. Report local compute separately. Savings count only when the task succeeds.

## MCP Servers and Harness Ownership

Expanded integration design. MCP servers are independent local processes or remote services, not a collection of servers shipped inside AgentOS. We configure existing servers and reuse their capabilities; custom servers are reserved for missing demo-specific operations.

| Layer | Ownership |
| --- | --- |
| Existing MCP servers | Provide GitHub, Slack or email, Drive, filesystem, database, and custom internal-tool capabilities. Each requires its own setup, credentials, and permissions. |
| Hermes adapter in the MVP | Delegate connection, discovery, schema loading, invocation, and tool-result delivery to the harness MCP client. Translate these into AgentOS contracts. |
| AgentOS core | Own provider catalog, stable tool IDs, selection, context scope, hard policies, approvals, and traces. Core types must not import Hermes types. |
| Other harnesses later | Implement the same discovery and invocation adapter; optionally use a standalone MCP client. Only Hermes is integrated for the hackathon. |

**Integration spike first:** pin the Hermes revision and confirm that model requests, tool schemas, and every tool execution can be intercepted. These are adapter requirements, not promises about untested hook names. A gateway alone cannot gate tools executed inside a harness; add an execution wrapper where needed. No deep fork or copied agent loop.

## Hierarchical Tool Selection

- Discover connected tools once, normalize IDs such as `github.create_issue`, and cache full schemas separately from short routing metadata. Mark unavailable or unauthenticated servers ineligible.
- Apply user permissions and privacy constraints before selection. Jev sees sanitized task state and short family summaries, not all full schemas.
- Jev chooses families; metadata search retrieves candidates within those families; Jev selects a small final set. Send only those full schemas to the reasoning model.
- Validate the actual proposed tool ID, arguments, destination, and permission scope before invocation. Hiding a schema is an optimization, not authorization.
- If no suitable tool is found, widen the authorized candidate set once or ask the user. Do not invent tools or expose every server by default.

**ToolDescriptor fields:** id, provider_id, family, description, schema_ref, transport, risk_class, required_scopes, allowed_data_labels, credential_ref, availability, and executor_ref. Store schemas and credential references locally; never store credential values in routing metadata.

## Plugins, Browser and Context Boundaries

An AgentOS plugin is a configuration bundle, not a new agent framework: plugin ID and version, provider type, MCP endpoint or local command, tool metadata, credential references, permission scopes, privacy defaults, and display information. A YAML or JSON manifest is enough for the MVP; no marketplace or installer is required.

Normalize MCP, REST adapters, local functions, browser workflows, shell commands, and harness-native tools through ToolDescriptor and the same authorization path. Treat plugin descriptions and tool results as untrusted data, never as permission-granting instructions.

| Browser capability | Default gate |
| --- | --- |
| Search, open, extract | Auto only for approved public destinations and non-sensitive inputs. Even a search query can leak private data. |
| Click, type, download | Inspect target, arguments, data labels, and likely side effect. A click may submit, purchase, or delete. |
| Submit, send, purchase | Require approval bound to the exact destination and payload; recheck after approval before execution. |

Jev chooses browser capabilities and assesses risk; the harness reasoning model plans browser actions and the browser backend executes them. Browserbase is a remote data recipient: local-only inputs, screenshots, cookies, and credentials must not be uploaded there. Use local browser execution or block the step when policy requires it.

## Central Context and Model Gateway

Keep conversation, task plan, preferences, artifact references, tool outputs, labels, and events in local SQLite for the MVP. Build each request from pinned instructions, recent valid message/tool-call pairs, a bounded summary, and relevant artifact excerpts. Preserve provenance and sensitivity labels through summaries and derived outputs; truncation does not make private data public.

The model gateway owns provider credentials, tier-to-provider mapping, format adaptation, capability checks, usage, and timeouts. Escalation may only choose a policy-eligible model; private local-only work cannot silently escalate to cloud. Bound retries and never retry an external write blindly. Jev confidence describes its routing decision, not guaranteed answer quality.

## Breadth Without Integration Overload

Target catalog: GitHub, filesystem, browser, Slack or email, Drive, database, and one internal-tools provider. Wire the 2–3 providers needed for the demo first; expand only after the full run works. Aim for 50–100 schemas, exposing roughly 3–8 per step. Clearly label simulated tools as non-executable fixtures and separate synthetic catalog savings from live integration counts.

**Required tests:** unavailable server excluded; unknown or unselected call blocked; denied approval never executes; approval applies to one exact action; synthetic secret absent from cloud payloads and traces; tool output cannot override policy; schema filtering preserves task completion. Include Jev and verification overhead in cost and latency comparisons; label cached replay clearly.

## Build Timeline and Integration Gates

Planning assumption: 36 hours. Everyone starts together, then builds against frozen contracts and mocks. Person 1 leads integration; nobody waits for the full backend to begin their component.

| Hours | Parallel work and required checkpoint |
| --- | --- |
| 0–1.5 | All: freeze demo, repo setup, ScheduleRequest, ScheduleDecision, ToolDescriptor, ToolAction, and StepEvent. P1 validates Hermes interception immediately; P2 checks Jev access; P3 checks browser/MCP credentials; P4 mocks events. |
| 1.5–6 | P1: run API, SSE, mock adapter and pause/resume. P2: typed scheduler and mock fixtures. P3: catalog, labels, policy and context. P4: timeline and approval UI. **Gate:** mocked end-to-end run, reject/approve, resume, finish. |
| 6–12 | P1: real Hermes adapter. P2: three model tiers and routing. P3: live browser plus required MCP providers and schema filtering. P4: real event stream and approvals. **Gate:** live model/tool run visible in UI. |
| 12–18 | P1: execution checks, errors and timeouts. P2: bounded escalation and baseline runner. P3: privacy checks and approval enforcement. P4: cost/context metrics. **Gate:** complete demo with local analysis, public research, escalation, and approved action. |
| 18–26 | Freeze features. P1 tests run reliability; P2 evaluates quality and overhead; P3 tests leakage and permission bypass; P4 validates metrics and error states. Run the demo at least 10 times; label live versus cached replay. |
| 26–31 | P1 packages one-command startup; P2 prepares measured results; P3 documents setup and safety limits; P4 prepares recording, README visuals and pitch. All resolve blockers only. |
| 31–36 | Rehearse: problem 30s, product 30s, demo 150s, architecture 45s, results 30s, future 15s. Verify credentials, synthetic data, reset procedure, and backup recording. |

**Shared contracts:** ToolAction carries run_id, step_id, tool_id, arguments, and action_id. StepEvent carries run_id, step_id, event type, timestamp, route, decision confidence, policy result, usage, and status. Proposed API: create run, stream events, stop run, and approve/reject action. Contracts are our own, independent of Hermes endpoint names.

**If behind schedule:** cut optional integrations, catalog size, and UI extras first. Never cut the execution-time policy check, truthful metrics, or one working end-to-end demo. Keep synthetic routing fixtures distinct from live tool execution.

## Team Work Split

Agree on the scheduler schema, event schema, and mock responses first. Each owner then builds against those contracts so all four tracks can progress in parallel.

| Owner | Primary scope | Concrete deliverables | Integration contract |
| --- | --- | --- | --- |
| Person 1 | Core runtime and harness | Run API; Hermes adapter and compatibility spike; model/tool interception; SSE; pause/resume; context persistence plumbing | Consumes ScheduleDecision; emits StepEvent and proposed ToolAction |
| Person 2 | Jev scheduler and model routing | Jev schemas; hierarchical selection; model gateway; tier routing; context ranking; bounded escalation; baseline evaluation | Implements schedule(state) and returns deterministic mock fallback |
| Person 3 | Tools safety and context | MCP setup; ToolDescriptor registry; plugin manifests; browser adapter; privacy and risk rules; execution-time authorization | Implements build_context, select_tool_metadata, and authorize_action |
| Person 4 | Dashboard metrics and demo | Dashboard; approvals; provider/tool counts; metrics; synthetic demo fixtures; replay labeling; presentation | Consumes StepEvent stream; calls approve or reject endpoints |

### Integration Order

- Checkpoint 1: shared schemas, mocked scheduler, mocked event stream, and one manual approval path.
- Checkpoint 2: Hermes text-only run through the adapter, then real model routing, then filtered tools.
- Checkpoint 3: browser and privacy flow, dashboard trace, and end-to-end demo task.
- Final pass: freeze features; run the baseline and AgentOS task repeatedly; polish failure handling and the presentation.

### One Sentence Pitch

**AgentOS is a harness agnostic runtime that uses Jev to choose the cheapest safe model, tools, and context for every agent step, while making each decision visible and enforceable.**
