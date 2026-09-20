# AgentOS Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The immediate evaluation audience is hackathon judges. The interface lets a person submit an open-ended task, observe execution, inspect recorded decisions, monitor usage, and intervene. The long-term primary user segment remains open.

## Product Purpose

AgentOS is a harness-agnostic control plane that makes AI agents faster, cheaper, more private, and easier to supervise. Its frontend makes the existing system understandable through a minimal chatbot interface and a live decision graph.

The product name is AgentOS. The user wants a distinctive, carefully designed interface rather than a generic AI dashboard. Visual direction has not yet been selected.

## Positioning

The differentiator is observable orchestration: model routing, tool selection, privacy boundaries, action approvals, and execution measurements are visible beside the user's task. Jev makes typed decisions; it does not generate responses or replace deterministic authorization.

## Operating Context

- The user is designing the frontend while backend work continues. Connect existing functionality where possible; incomplete integrations do not block UI exploration.
- Two requested demonstration scenarios are support research and everyday task assistance such as trip planning. Neither was selected as the exclusive primary scenario.
- The support scenario in the design spec uses synthetic customer data, local processing, public research, an account brief, and approval before outreach.
- Submitting a task should start the workflow without a separate review-and-launch screen. Preserve exact-action approval requirements during execution.
- Keep chat, the execution graph, token usage, estimated cost, task timing, and workflow pause controls easy to find.
- Provide a button to connect a specific harness. Hermes is the primary harness for the project's main use case.

## Capabilities and Constraints

### Existing integration foundations

- The frontend uses React, TypeScript, Vite, Tailwind CSS, React Router, and React Flow.
- The existing conversation API creates or modifies a workflow graph; a separate run API launches that graph. A submit-to-run experience can compose these calls without pretending that graph synthesis itself is execution.
- Run SSE supplies step updates, scheduling decisions, approvals, egress records, logs, and run status. It is not currently a general token-by-token assistant response stream.
- Shared analytics derive total and per-node tokens, estimated cost, and timing from reported events. Do not invent missing measurements, generation speed, savings, or budget limits.
- The existing graph is a workflow document with execution overlays. Distinguish planned structure from observed decisions; do not present generated graph nodes as proof that an action happened.
- The provider endpoint exposes provider mode, health, details, and capability bindings. Hermes is currently bound to the agent runtime capability.
- The live Hermes adapter uses a local ACP subprocess. Its health check attempts the ACP connection; reading provider status is not a passive configuration lookup.

### Required UI and integration boundaries

- Design a harness connection flow with Hermes as the primary supported adapter. Other harnesses are a future extension, not a claim of current support.
- Keep configured, connecting, healthy/connected, failed, disabled, and mock states distinct where the available data supports them. A healthy mock is not a live Hermes connection.
- No dedicated harness-selection, configuration-save, or disconnect endpoint was found in the current provider route. Backend connection lifecycle changes belong to the runtime owner; do not invent endpoints or collect arbitrary credentials in the browser.
- Pause/resume is a requested interaction, but the current run API exposes cancellation and approvals, not pause/resume. A labeled preview can demonstrate pausing simulated execution; live controls must not claim to pause a backend run until the backend confirms it.
- The graph represents recorded orchestration decisions and supplied explanations, not fabricated internal model reasoning. The Hermes adapter currently has known limits in per-tool visibility and enforcement; the UI must not imply those are resolved.
- Keep real API errors distinct from preview behavior. Do not silently replace a failed live request with a successful mock.
- Existing deterministic privacy, permission, and exact-action authorization rules remain authoritative. Starting immediately does not bypass them.
- Live, mock, fixture, and replay provenance must be labeled truthfully. Demo data is synthetic; unknown measurements must not appear as measured zeroes.
- Scope this work to the dashboard and its integration adapters. Runtime, policy, and authorization changes require the relevant owners. Shared published domain types permit additive edits only.

## Brand Commitments

- Name: AgentOS, not the FlowAI label in the reference images.
- User-requested qualities: minimalistic, outstanding in a hackathon presentation, and free of generic AI visual cliches.
- Preserve product behavior, integration contracts, safety constraints, and truthful data presentation while designing the frontend.
- Reinterpret the supplied concept images: retain the chat, live graph, and metrics idea, but explore a distinctive composition and visual identity instead of copying them. Their dark palette and three-column layout are not binding. No palette, typeface, or composition is approved yet.

## Evidence on Hand

- `../../docs/agentos-design.md`: source of truth for scope, safety invariants, contracts, team ownership, and the support demo. Operational Jev integration guidance in the repository rules supersedes its older SDK reference.
- `../../docs/frontend-design/ChatGPT Image Sep 20, 2026, 01_05_18 AM.png` and `../../docs/frontend-design/ChatGPT Image Sep 20, 2026, 01_05_20 AM.png`: concept images, not evidence of implemented capabilities or measured performance.
- `src/lib/api.ts`, `src/hooks/useRunStream.ts`, and `../../packages/shared/src/analytics.ts`: existing frontend integration and measurement foundations.
- `src/components/graph/GraphCanvas.tsx`: existing React Flow implementation.
- `../../apps/api/src/api/providers.routes.ts` and `../../apps/api/src/providers/hermes/live.ts`: current provider status and Hermes connection behavior.

## Product Principles

1. Make the user's task and current execution state understandable before exposing diagnostic detail.
2. Let people inspect the recorded evidence behind orchestration decisions without overwhelming the main conversation.
3. Preserve visible human control and exact-action authorization, including in a submit-to-run experience.
4. Distinguish measured behavior, reported behavior, planned structure, and simulated previews.
5. Reuse the existing contracts and components rather than building a disconnected showcase.

## Open Decisions

- Composition and visual identity within the confirmed reinterpretation of the reference concepts.
- The precise connection panel interaction and placement of the harness control.
- Graph expansion, density, long-run behavior, and mobile presentation.
- Backend-owned contracts for confirmed pause/resume and any new harness lifecycle operations.
