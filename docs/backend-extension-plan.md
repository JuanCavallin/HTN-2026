# Backend extension plan — Zephyr beyond the hackathon

Drafted 2026-09-23 (decisions grilled the same day, see below) from a full read of `apps/api/src`, `packages/shared`, the check
suites, the roadmap, and the unmerged `krish/edit-running-workflow-node` branch. Backend
only. Ordered so each phase is shippable on its own and earlier phases de-risk later ones.

Effort: S = ≤½ day, M = 1–3 days, L = a week+.

## Decisions (grilled 2026-09-23)

| # | Decision |
|---|----------|
| D1 | Target: **product for other teams** (external users). |
| D2 | Tenancy: **one API key per team**, `owner_id` on every tenant-scoped table; users/orgs later. |
| D3 | Harness: an **in-process OpenAI-compatible tool-loop adapter becomes primary**; Hermes stays as the external-harness demo. Gateway surfaces kept clean so bring-your-own-harness falls out. |
| D4 | Run/graph/playbook layer **stays a maintained product surface** alongside the gateway. |
| D5 | Phase 0 is a **hard gate**: one PR, nothing else merges first. |
| D6 | Auth lands **end of Phase 1**, as migration 001 on top of the migration runner. |
| D7 | The in-process adapter is **Phase 1 item 0**; all other Phase 1 work assumes it. Hermes gets only 0.7/0.8. |
| D8 | The adapter is a **real HTTP client** of `/v1` + `/mcp` (loopback), so it doubles as the BYO-harness contract test. |
| D9 | **`POST /api/sessions`** (mint gateway tokens without a run) is public and documented in Phase 1; the adapter is its first client. |
| D10 | A BYO session is a **`Run` of kind `external`**: no orchestrator loop, terminal via `POST /runs/:id/complete` or token TTL. |
| D11 | **Merge node-edit branch** right after 0.1, adding a `node.edited` before/after + re-classified-risk event. Edits allowed while paused. |
| D12 | Privacy now = **2.1 gateway redaction + 2.5 imported tool outputs** only; rehydration, ledger v2, new detectors deferred. |
| D13 | Policy packs first cut = **budgets + tool allow/deny + approval amount threshold**, per tenant; vocabulary merge (3.2) first. |
| D14 | Approval notifications: **webhook only** (HMAC). Retention **30 days**, PII purge at terminal status. Escalation **cheap→frontier within the same privacy class**. Tests on **`node:test`**. Deploy: **one container + SQLite volume**. |

## Four parallel lanes

Lanes follow file ownership so four people never touch the same files in the same phase.

| Lane | Owns | Files |
|------|------|-------|
| **A Runtime** | adapters, sessions, runs, stream, approvals waiter | `core/orchestrator.ts`, `core/sessions/*`, `core/pauseGate.ts`, `core/approvalGate.ts`, `providers/hermes/*`, `services/runs.service.ts`, `services/approvals.service.ts`, `api/runs.routes.ts`, `api/stream.routes.ts`, `api/approvals.routes.ts` |
| **B Policy** | decisions, risk, model gateway, redaction, ledger, content check | `core/decisions/*`, `core/risk.ts`, `core/modelGateway/*`, `core/redaction.ts`, `core/ledger.ts`, `core/tools/contentCheck.ts`, `providers/jev/*`, `providers/{openrouter,gemini,ollama,anthropic}/*` |
| **C Tools** | broker, registry, browser, MCP, Composio | `core/tools/*` (except contentCheck), `core/mcp/*`, `providers/{browserbase,localbrowser,composio,mcp,gptzero}/*`, `services/toolCatalog.ts`, `api/tools.routes.ts`, `api/mcpConnections.routes.ts` |
| **D Platform** | store, graph runtime, HTTP plumbing, tests, ops | `store/*`, `core/graph/*`, `api/{index,app,middleware}/*`, `api/graphs.routes.ts`, `services/graphs.service.ts`, `scripts/*`, `.github/*`, Dockerfile |

Cross-lane contracts (additive, agree before building): `Policy` type (B→all), `owner_id` + migration runner (D→A,B), `POST /api/sessions` (A→C for BYO tool tests), `AgentRuntimeAdapter.onPermissionRequest` (A→C).

## Where the codebase actually is

Strong: `api → services → core` layering is real; broker is the single execution path
for registry tools and fails closed on grant/version/scope/schema/labels; per-session
hashed gateway tokens; bus persists-then-fans-out; 12 offline invariant suites in CI.

Weak, in one sentence each:

- Privacy is enforced by **labels**, not bytes: `/v1` forwards messages verbatim, and
  two side-channels (Jev browser decider, GPTZero) get text with no label gate.
- Everything that holds a run together is **in-process** (approval waiters, pause
  latches, Hermes subprocesses, gateway tokens, scopes). Restart = cancel all.
- **Policy is ~6 constants** across four files with two competing risk vocabularies.
- A graph document can **downgrade an irreversible tool to `auto`** via `actionKind`.
- No auth, no tenancy, no budgets beyond step count, no retention, no queue.
- Headline README claims not implemented: PII round-trip, verification escalation,
  "one Hermes at a time" (stale, now unbounded), browser-target cache (exists, but
  in-memory/global/unbounded).

## Phase 0 — close the policy bypasses (all S, ship as one PR)

Each is a violation of a stated invariant. No new features until these land.

| # | Fix | Where |
|---|-----|-------|
| 0.1 | `toolRisk(tool, explicit)`: explicit `actionKind` may only **tighten**, never loosen; take strictest of explicit / table / registry descriptor | `core/graph/toolRisk.ts:63` |
| 0.2 | Gate GPTZero on `action.dataLabels`: skip (and log) unless all labels are `public`/`private`; record an egress span | `core/tools/contentCheck.ts:126` |
| 0.3 | Gate Jev browser decider on labels: `local_only`/`secret` sessions use the deterministic decider; route the live call through `withEgress` so it appears in the ledger | `core/tools/browser.ts:172`, `providers/jev/browserDecider.ts` |
| 0.4 | Delete the un-brokered `toolbox` fallback for graph `tool` nodes (`callToolGated` when registry lacks the tool); unknown tool = fail closed | `core/graph/interpreter.ts:439-560` |
| 0.5 | Block `file:` URLs in browser navigation | `core/tools/browser.ts:262` |
| 0.6 | Unknown `sessionId` fails in the browser executor, not only at the provider wrapper | `core/tools/browser.ts:278` |
| 0.7 | Hermes ACP: match permission options on `kind`, not `optionId`; `readTextFile`/`writeTextFile` return errors instead of fake success | `providers/hermes/live.ts:309-318` |
| 0.8 | Kill spawned Hermes subprocesses on shutdown (module-level Set + SIGTERM) | `index.ts:36`, `providers/hermes/live.ts:246` |
| 0.9 | Model-call failure is a **failed step**, not `'Unavailable (…)'` text; `judge` fallback to `options[0]` at confidence 0 becomes a failure | `core/graph/interpreter.ts:423,781` |

Tests: extend `tool-broker.check.ts`, `graph-schema.check.ts`, `content-check.check.ts`,
`browser-tools.check.ts` with one negative case each.

Then merge `krish/edit-running-workflow-node` (clean merge-tree against main; rerun
`check:graph`). Add: `node.edited` event carries before/after + re-classified risk; move
`LIVE_NODE_EDIT_NOTES.md` under `docs/`. Decision: allow edits while paused.

## Phase 1 — run reliability (M total)

Goal: a team can leave the API running and deploy it without losing work.

1. **Concurrency + queue.** Semaphore on `agent_task` (env `MAX_LIVE_AGENT_TASKS`,
   default 1) and a `queued` run status with FIFO; `POST /runs` never spawns unbounded
   Hermes processes. Fix README's stale "one at a time" claim to match.
2. **Idempotency.** `Idempotency-Key` header on `POST /runs` → `(key, runId)` table, 24h.
   Repeat `decide` on an approval returns the prior result, not 409.
3. **Approvals.** `payloadHash` + `expiresAt` on `Approval`; `decide` must echo the hash;
   sweeper marks `expired`; deny-memo per `(run, tool, argsHash)` so Hermes can't loop on
   re-proposing a denied action; `approval.requested` fires an outbound webhook (env URL,
   HMAC-signed).
4. **Cancellation.** Abort-aware `sleep`; `KeyedLock.acquire` checks signal before
   waiting; Hermes adapter honours `ctx.signal`; `cancelTask` never respawns a dead
   process; Hermes process death marks the `TaskRecord` failed immediately.
5. **Global `/stream` replay.** Use SQLite rowid as the SSE id; honour `Last-Event-ID`.
6. **Store hygiene.** `user_version`-based numbered migration runner (replace the
   `PRAGMA table_info` hack); wrap `patchRun/Step/Approval/SessionState` and
   `mutateGraph` in transactions or `UPDATE … WHERE version = ?`; `DELETE /runs/:id`;
   retention job (env `RUN_RETENTION_DAYS`) that also purges `pii` rows; delete the dead
   memory-snapshot-to-disk path.
7. **Orchestrator tests.** New `orchestrator.check.ts` on memory store + mock adapters:
   pause at boundary, cancel-while-paused, cancel-while-awaiting-approval, restart
   recovery, queue ordering. Add the missing spec tests: revised-action re-auth, policy
   injection through tool output, pause/resume.
8. **Graceful shutdown.** SIGTERM drains: stop accepting runs, wait up to N s for
   in-flight steps, then `recoverInterruptedRuns` semantics.

## Phase 2 — make privacy real (M–L)

1. **Gateway redaction.** Run the regex redactor over `/v1` messages before any cloud
   backend; store spans on the session; labels stay as the coarse gate, bytes are the
   fine one.
2. **Rehydration at the local boundary.** Wire `rehydrate()` into the final result and
   into outbound drafts that the human approves; add an egress assertion that raw span
   values never appear in a cloud payload (rename/fix `containsPlaceholders`).
3. **Label poisoning.** Hermes-internal tool messages should label `private`, not
   `local_only`; `local_only` requires a broker-produced marker. Surface "no eligible
   route" as a paused/blocked run with a reason, not a 502.
4. **Ledger v2.** Add `dataLabels`, `routeId`, `sessionId`, `bytes`, `payloadHash`,
   `blockedReason` columns; index on `(provider, destination, at)`; `GET /api/egress`
   with filters (provider, destination, label, date range). This is the data the
   README's "learn which steps never needed the frontier model" needs.
5. **Imported tool outputs reach the model.** Composio and MCP executors produce a
   bounded, redacted `modelOutput` (size cap, redactor, label-aware release). Without
   this every imported read tool returns "Completed X through Y" and is useless.
6. **PII detectors.** Add SSN, credit card (Luhn), IBAN, passport; make `name`/`address`
   either detected or removed from `PiiType`.

## Phase 3 — policy packs, budgets, auth (L)

1. **`Policy` record** in store + API: budgets (tokens, cost cents, wall-clock), approval
   thresholds, tool/provider allow/deny, label→route matrix, allowed egress destinations
   (residency), confidence thresholds. `DecisionService`, `ToolBroker`,
   `eligibleModelRoutes`, `classify()` take it as an argument instead of module
   constants. One default policy seeded; `Run.policyId` optional.
2. **Merge the two risk vocabularies** (`core/risk.ts` kind-strings vs
   `decisions/eligibility.ts` descriptor `ActionPolicy`); delete `toolRisk.ts` table
   (the `TODO(person-3)`).
3. **Enforce budgets.** Accumulate tokens/cost/time from `model.lifecycle` into
   `SessionBudget`; check at the gateway and at each outer-loop checkpoint; over-budget
   → `blocked` run, not silent continue.
4. **Structured destinations + narrow-only.** Destination becomes a set (all recipients
   incl. cc/bcc; host+path for browser; per-session Browserbase region); hash into the
   approval; revision must be a subset on declared `revisableFields`.
5. **Auth + tenancy (minimum).** Bearer API key in `requestContext`; `owner_id` on
   runs/graphs/conversations/mcp_connections/approvals/policies; store methods take
   `{ownerId}`; SSE via token-in-query. `/v1` and `/mcp` already have scoped tokens.
   Rate limit on `POST /runs`, `/optimize`, `/providers/composio/*`.
6. **Configurable thresholds** via policy, not env (`minimumConfidence`, `maximumTools`,
   `TOOL_THRESHOLD`, browser `LOW_CONFIDENCE_THRESHOLD`).

## Phase 4 — harness-agnostic for real (M)

1. Replace the four literal `'hermes'` checks (`sessions/service.ts:85,143`,
   `orchestrator.ts:847,1161`, `interpreter.ts:802`) with `session.harness`; make
   `agent.runtime` a map keyed by harness; `AgentTaskSpec.harness` selects.
2. Add `onPermissionRequest` to `AgentRuntimeAdapter` and route it through
   `classify()` + the approval gate (this is also what fixes the Hermes always-deny).
3. **Second adapter.** Recommend a generic **OpenAI-compatible tool-loop adapter**
   (in-process, no subprocess) as the first non-Hermes harness: it proves the boundary,
   is trivially testable, and gives mock-mode a real agent loop instead of fixtures.
   Claude Agent SDK next (needs a `/v1/messages` gateway surface).

## Phase 5 — extension features (pick by demand)

- **Graph run resume** (M): skip nodes with succeeded steps, re-run from first
  non-terminal; `continue` scopes restart fresh. Persist `contextScopes`.
- **Triggers** (M): `triggers` table; `POST /api/triggers/:id/fire` (HMAC) and a cron
  tick on startup; dedupe via idempotency keys. `shared/scheduling.ts` is misnamed
  (it's Jev routing) — rename.
- **Verification-driven escalation** (M): consume `verificationFailures` to widen the
  route pool on `continue`; set `escalated: true`. Spec acceptance criterion, unmet.
- **Decision cache** (M): memo Jev route/tool decisions on sanitized-state hash +
  candidate ids; persist the browser target cache per origin with a size cap.
- **Graph node types** (L): `map`/`foreach` over arrays, bounded loops, sub-graph call,
  per-node retry/timeout/failure policy, typed run-input schema; validate `{{refs}}`
  and tool names at save.
- **Tool review lifecycle + manifests** (L): `reviewed`/overrides table; imports default
  to `pending_review`; admin approve endpoint; `config/plugins/*.json` loader (the dir
  AGENTS.md promises doesn't exist); shared verb classifier that also reads MCP
  `annotations`; consistent sanitized description policy.
- **MCP stdio** (L): child-process transport with cwd/env allowlist, lifecycle owner,
  reconnect/backoff, `tools/list_changed`, persistent client per connection.
- **New tool families** (L): `http.fetch` (public only), `fs.read/write` (local_only,
  path allowlist, destination = path), `shell.exec` sandboxed. Needs per-argument effect
  classification and `outboundTextFields`/`recipientFields` descriptor metadata.
- **Live browser `extract`** (M): both adapters treat instructions as CSS selectors, so
  `search/read/extract` cannot work live. Route prose through a bound text model over
  the element table; unhardcode google.com.
- **Ops** (S–M): Dockerfile (multi-stage, `express.static(dist)` + SPA fallback), JSON
  logs with request id on events, `/metrics`, `/health` that checks store + providers,
  OpenAPI from the existing zod schemas, migrate checks to `node:test`, run smoke in
  CI against an ephemeral `MOCK_ALL` server.
- **Cost accuracy** (S): OpenRouter `usage.include`, Gemini cost, Jev cost; catalog from
  provider listing not env pairs.

## Explicitly not doing

Multi-region/distributed execution · enterprise RBAC beyond owner_id · production
secret manager · a plugin marketplace · UI work (separate plan) · replacing Hermes.

## Suggested sequencing for one person

Phase 0 (1–2 days) → merge node-edit → Phase 1 items 1,3,4,6,7 (1 week) → Phase 2 items
1,2,5 (1 week) → Phase 3 items 1–3 (1–2 weeks) → Phase 4 (1 week) → Phase 5 by demand.

## Board and issue map

Board: [HTN-2026 Board](https://github.com/users/KrishP147/projects/4) (GitHub Project under
KrishP147, see `AGENTS.md` "Workflow skills: Zephyr overrides"). Labels: `lane:A-D`, `phase:0-5`,
`size:S/M/L`. Decisions and transcripts: `skilleddocs/`.

| Plan id | Issue |
|---|---|
| `A0` | #9 |
| `B0a` | #10 |
| `B0b` | #11 |
| `C0` | #12 |
| `D0a` | #13 |
| `D0b` | #14 |
| `D0c` | #15 |
| `D0d` | #16 |
| `A1` | #17 |
| `A2` | #18 |
| `A3` | #19 |
| `A4` | #20 |
| `A5` | #21 |
| `A6` | #22 |
| `A7` | #23 |
| `B1` | #24 |
| `B2` | #25 |
| `B3` | #26 |
| `B4` | #27 |
| `B5` | #28 |
| `B6` | #29 |
| `B7` | #30 |
| `C1` | #31 |
| `C2` | #32 |
| `C3` | #33 |
| `C4` | #34 |
| `C5` | #35 |
| `C6` | #36 |
| `D1` | #37 |
| `D2` | #38 |
| `D3` | #39 |
| `D4` | #40 |
| `D5` | #41 |
| `D6` | #42 |
| `D7` | #43 |
| `D8` | #44 |
