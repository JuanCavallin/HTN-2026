# MCP, Composio, and OpenRouter Integration Plan

> **Archived — historical planning document.** Kept for the record of how Zephyr/AgentOS
> was built during Hack the North 2026. It may describe work that has since changed; the
> current docs are the [README](../../README.md), [agentos-design.md](../agentos-design.md)
> and [DEMO.md](../DEMO.md).

This is the immediate execution plan after the trusted registry and exact-action broker.
It is deliberately split into small mergeable changes so the Composio and OpenRouter
tracks can proceed in parallel without bypassing AgentOS.

## Target flow

```text
Hermes model request
  -> AgentOS model gateway
  -> Jev selects eligible model + tools
  -> OpenRouter/local model proposes a tool call
  -> Hermes calls AgentOS MCP endpoint
  -> Tool Broker validates and authorizes the exact action
  -> approval when required
  -> Composio/local executor runs once
  -> result and labels enter canonical session state
  -> Hermes continues
  -> verified Jev completion ends the run
```

Two boundaries are non-negotiable:

- Hermes never connects directly to Composio's MCP endpoint. That would bypass the
  AgentOS exact-action broker.
- OpenRouter server tools are not used for MVP actions. We send user-defined function
  schemas and execute their calls ourselves so every action crosses AgentOS policy.

## Phase 0 — Harden the shared boundaries [complete]

Finish these before live providers are used.

### 0.1 Turn-scoped tool exposure

The current session stores the latest selected tool IDs. Hermes also makes auxiliary
requests such as title generation, and a no-tool auxiliary request must not erase the
tools selected for the actual task.

- Add a turn-scoped `ToolExposureGrant` containing session ID, turn, model-call ID,
  selected descriptor versions, and timestamps.
- Create or replace the active grant only for a model request that actually contains
  candidate tool schemas.
- No-tool auxiliary requests may be logged but cannot mutate the active grant.
- Expire the grant on turn completion, continuation, cancellation, or failure.
- Make the Tool Broker authorize against the active grant. Keep
  `session.selectedToolIds` as the UI summary, not the security authority.

### 0.2 Tool wire-name mapping

Run a compatibility spike with one local tool and record the exact MCP tool name Hermes
places in its OpenAI-compatible model request.

- Add a trusted `wireName <-> stable AgentOS ID` mapping to the registry.
- Jev and policy use stable IDs such as `mail.send`.
- Hermes and model APIs may use compatible wire names such as `agentos_mail_send`.
- Unknown aliases fail closed. Never derive policy from a vendor or model-provided name.

### 0.3 Tool-output privacy propagation

- Extend executor results with output `dataLabels` and an optional explicitly sanitized
  summary.
- Merge result labels into canonical session state before returning the MCP response.
- Treat incoming `tool` messages as local-only until an explicit sanitizer says
  otherwise.
- Recompute model eligibility from the effective labels before the next model call.
- A local-only tool result must force a local route; it must never silently reach
  OpenRouter or remote Jev.

### 0.4 Tool-capable model eligibility

- Resolve eligible tool candidates before final model routing.
- When selected tools are non-empty, restrict model candidates to
  `supportsTools: true`.
- If no eligible tool-capable route remains, fail closed or continue without tools; do
  not send schemas to a route declared incapable of tool calling.

**Gate A:** checks prove that an auxiliary model call cannot erase a task grant, aliases
cannot bypass selection, local-only tool output cannot reach a cloud route, and a
non-tool-capable model never receives tools.

## Phase 1 — AgentOS MCP gateway [transport complete; live model call pending Phase 2B]

Use the official TypeScript MCP SDK with a stateless Streamable HTTP transport mounted
inside the existing Express API. HTTP is preferable here to a stdio child because the
same process already owns the in-memory session, approval waiter, registry, and broker.

### Files

- `apps/api/src/core/mcp/server.ts` — MCP server and tool handlers.
- `apps/api/src/api/mcp.routes.ts` — authenticated `/mcp` transport.
- `apps/api/src/config.ts` — local MCP URL/token settings.
- `apps/api/src/providers/hermes/live.ts` — generated Hermes MCP configuration.
- `apps/api/scripts/mcp-gateway.check.ts` — transport and bypass checks.

### Behaviour

- `tools/list` returns trusted registry schemas and wire names only. No resources,
  prompts, credentials, or executor details are exposed.
- `tools/call` parses JSON arguments, resolves the active Hermes session, translates the
  wire name to a stable ID, and calls `toolBroker.execute(...)` exactly once.
- Map broker success to MCP content; map policy/validation failures to `isError: true`
  without leaking credentials or unrelated session state.
- Authenticate the endpoint with a dedicated local bearer token.
- Preserve the current single-active-Hermes-session constraint. Zero or multiple active
  sessions fail closed; concurrent-user correlation is a post-demo improvement.

### Hermes configuration

Generate an `agentos` entry under `mcp_servers` pointing to the local `/mcp` endpoint,
including the bearer header. Stop setting `HERMES_ACP_SKIP_CONFIGURED_MCP=1` for this
isolated profile. Keep native write/destructive permissions denied through the ACP
permission callback.

First prove the path with one safe, deterministic local read tool. It is a real local
executor, not a `simulated: true` fixture:

`Hermes -> AgentOS MCP -> Tool Broker -> local executor -> Hermes`

**Gate B:** a live Hermes run calls the safe tool; an unselected tool, changed
descriptor version, bad arguments, missing approval, and direct executor bypass all
fail. The SSE trace contains model selection, tool selection, proposal, policy,
execution, result, and completion.

Implemented status: the authenticated endpoint, Hermes profile injection, trusted
discovery, prefixed-name compatibility, broker execution, grant expiry, and lifecycle
trace pass. Hermes's own probe discovers `agentos_runtime_status`, and the MCP SDK check
executes it through the broker. The final model-triggered Hermes call is intentionally
deferred until Phase 2B supplies a real tool-capable model route; the current bound text
adapter truthfully declares `supportsTools: false`.

## Phase 2A — Composio adapter [parallel after Gate A]

**Implemented September 20:** REST v3.1 was used because the local Node runtime is below
the current SDK minimum. OAuth link/status/refresh endpoints, stable user isolation,
versioned schema discovery, the reviewed allowlist, and the Gmail-send executor are
wired. Gate C still requires a real Composio key, auth config, connected Gmail account,
and approve/reject execution proof.

Do not expose Composio directly as Hermes's MCP server. Use the current registry and
executor interfaces.

### Runtime prerequisite

The current local Node runtime is 22.20.0. The current Composio TypeScript SDK documents
Node 22.22.3 or newer, so either upgrade the team runtime and `engines` field first
(recommended) or implement the same adapter against Composio's HTTP API.

### Work

- Install `@composio/core` only in `@htn/api`.
- Implement `apps/api/src/providers/composio/live.ts` without leaking SDK types.
- Use a stable demo user ID and connected-account ID; do not use a global implicit
  account when more than one connection exists.
- Add connect/status endpoints that return an OAuth/Connect Link and connection state.
- Discover only the reviewed demo toolkit/tools initially.
- Fetch each tool's raw schema and required scopes, translate its vendor slug to a
  stable AgentOS ID, and register its exact pinned provider version.
- Never use `dangerouslySkipVersionCheck`; Composio currently requires explicit tool
  versions for manual execution.
- Register granted scopes from the actual connection state. Disconnected tools remain
  `requires_connection`.
- Register an executor that resolves the exact destination locally and calls
  `composio.tools.execute(...)` once with the user, connected account, pinned version,
  exact arguments, and abort signal.
- Send the executor through the wrapped provider path so destination, latency, and
  errors enter the egress ledger.
- Classify unmatched tools as `unknown`; they are not executable.

Start with three reviewed tools:

1. One read-only mail/profile tool (`auto`).
2. One draft/recoverable tool (`verify`).
3. One outbound email tool (`ask_user`).

Confirm current Composio slugs through discovery rather than hard-coding guessed names.

**Gate C:** connection state and scopes are truthful; schemas are version-pinned; a read
runs automatically; an email send pauses on its exact recipient/subject/body; reject
does not execute; approval executes once; no credential reaches Hermes, Jev, SSE, or
stored session context.

## Phase 2B — OpenRouter backend [parallel after Gate A]

**Implemented September 20:** OpenRouter and Ollama are separate backends behind the
same AgentOS gateway. The configured OpenAI tiers are `openai/gpt-5.6-luna` (cheap) and
`openai/gpt-5.6-sol` (frontier); both currently advertise tool support. `qwen3:8b` is
the true local/private route. OpenRouter credential health and live Ollama calls pass.

Use OpenRouter's Chat Completions API behind the existing AgentOS model gateway. Do not
use an OpenRouter agent loop because Hermes remains the harness and AgentOS remains the
control plane.

### Contracts and files

- Add `openrouter` to provider/config vocabulary and `.env.example` using
  `OPENROUTER_API_KEY` and an optional base URL.
- Promote the existing `ChatModelBackend` seam into a wrapped provider adapter (or an
  equivalently ledger-wrapped backend) so an unlogged OpenRouter call is unreachable.
- Implement provider code under `apps/api/src/providers/openrouter/`.
- Replace placeholder routes in `core/modelGateway/catalog.ts` with an explicit,
  server-owned allowlist of real model IDs and capabilities.

### Behaviour

- Forward only the AgentOS-selected model ID, messages, trusted tool schemas, token
  limit, and required routing/privacy controls.
- Parse text and all returned function tool calls without executing them.
- Preserve tool-call IDs and exact JSON argument strings for Hermes.
- Record actual model/provider identity, latency, prompt/completion tokens, and cost
  when returned.
- Implement cancellation, timeout, bounded retry for safe read-only model requests,
  and ordered fallback only among policy-eligible routes.
- Never retry or execute a tool action inside the OpenRouter adapter.
- Keep a separately truthful local model route; OpenRouter is cloud even when ZDR or
  no-training constraints are enabled.

Initial allowlist should contain a cheap tool-capable route and a stronger tool-capable
route from different model families. Model IDs stay in configuration because provider
catalogs change; Jev selects only from that allowlist.

**Gate D:** switching the Jev-selected route changes the actual OpenRouter model; both
routes preserve tool calls; local-only state never calls OpenRouter; usage appears in
the egress ledger; a provider failure falls back only to another eligible route.

## Phase 3 — Integrated agentic email acceptance test

Run this task from the AgentOS run API first, then from the UI:

> Draft an email to the configured demo recipient about the synthetic account review.
> Show the exact recipient, subject, and body. Send it only after I approve.

The test must prove:

1. Hermes starts from AgentOS and requests a model through the gateway.
2. Jev chooses one eligible OpenRouter/local route and a small mail tool subset.
3. OpenRouter returns a user-defined tool call; it does not execute it.
4. Hermes calls the AgentOS MCP tool, not Composio directly.
5. The broker validates the selected version, schema, scopes, destination, and payload.
6. The run pauses with an exact-action approval.
7. Reject produces no Composio execution.
8. Approve executes once and returns a provider message ID.
9. The result and labels enter canonical state.
10. Jev returns verified `done`, and AgentOS ends the Hermes loop.

Repeat once with a revised payload before approval. Revision must create a new action ID
and rerun authorization.

## Parallel ownership and merge order

| Change                                                              | Owner          | Depends on           | Merge gate    |
| ------------------------------------------------------------------- | -------------- | -------------------- | ------------- |
| PR 1: exposure grants, aliases, output labels, tool-capable routing | Core/Jev       | Current broker       | Gate A        |
| PR 2: AgentOS Streamable HTTP MCP + Hermes profile                  | Core/Hermes    | PR 1                 | Gate B        |
| PR 3A: Composio connection, registry bootstrap, executors           | Tools          | PR 1                 | Gate C        |
| PR 3B: OpenRouter adapter and explicit route catalog                | Models         | PR 1                 | Gate D        |
| PR 4: real email E2E, revision, trace fixtures                      | Integration/UI | PR 2 + PR 3A + PR 3B | Full scenario |

PR 3A and PR 3B should run in parallel. Do not make either provider integration depend
on the UI; the API/SSE acceptance test comes first.

## Definition of ready for UI integration

- One API-started live Hermes run completes the email scenario.
- Every real model and tool egress row names its provider, destination, policy, latency,
  tokens/cost where available, and live/mock status.
- Every tool call has a lifecycle trace and exact approval payload.
- All bypass, rejection, privacy, version-change, and provider-failure checks pass.
- The UI team only needs to start a run, subscribe to SSE, render events, and post an
  approval/rejection/revision; it does not contain orchestration or policy logic.

## Provider references

- [MCP TypeScript SDK server transports](https://ts.sdk.modelcontextprotocol.io/server)
- [Composio TypeScript SDK](https://docs.composio.dev/reference/sdk-reference/typescript)
- [Composio tool discovery and execution](https://docs.composio.dev/reference/sdk-reference/typescript/tools)
- [OpenRouter Chat Completions API](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request?explorer=true)
- [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
- [Ollama chat API](https://docs.ollama.com/api/chat)
- [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling)
