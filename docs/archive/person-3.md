# Person 3 — Tools and Browser

Person 3's scope is split across **two people**. Read this file top to bottom once,
then work only your track.

| Track                                 | Owns                                                                                                                                                              | Owner          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **3A — Tool Registry and MCP**        | The _plumbing_: `ToolDescriptor` registry, MCP client, plugin manifests, `select_tool_metadata`, non-browser executors. **Not the tools themselves — see below.** | `danielzhao07` |
| **3B — Browser, Browserbase and Jev** | The browser tool family: local + Browserbase backends, the element table Jev chooses from, the browser executor, session lifecycle                                | `danielzhao07` |

**Read [agentos-design.md](./agentos-design.md) first.** It is the source of truth for
the product, the step lifecycle, the safety invariants and the acceptance criteria.

**Read [jev.md](./jev.md) before writing any code that calls Jev.** Jev cannot generate
text. If you are writing a prompt for it, you are using it wrong.

---

## Progress

**Jev route (settled):** Vercel AI SDK → AI Gateway → `typesafe-ai/jev`, called with
`experimental_evaluate`. Credential `AI_GATEWAY_API_KEY`, read from the single slot
`config.providers.jev` that Person 2's adapter also uses. **`@typesafe-ai/sdk` is not
used anywhere.**

**3A — Tool Registry and MCP:** plumbing done and waiting on the sponsor API / MCP list.
Registry, manifest format + loader, `select_tool_metadata` and the gated executor
dispatcher are built and verified by `pnpm --filter @htn/api check:browser-tools`. **Connecting
a real tool should be one manifest file in `config/plugins/` plus one executor binding** —
that speed is the deliverable, not the tools. The MCP client is a boundary only until its
dependency lands (`3A-2`). No sponsor tools added, by design (`3A-6`).

**3B — Browser, Browserbase and Jev:** working end to end on both backends, and still
working after merging `origin/main`. Local Chrome and a real Browserbase session each
open, build an element table, act on a chosen index, refuse a stale snapshot, refuse an
occluded target, replay from cache with zero model calls, and release. Verified by
`node scripts/smoke_browser.mjs --mode local|browserbase`. Jev decisions currently come
from the **deterministic fallback** — the gateway decider is written and typechecks but
has not been run against a real `AI_GATEWAY_API_KEY`, and the trace labels its source
`deterministic` rather than implying a model call.

_Tick a box when the task is done **and verified by a command**, not when the code is
written. Update the status lines above when a track's phase changes._

Task IDs are stable — `C-*` shared contracts, `3A-*` and `3B-*` per track, `S-*` the
seam, `Q-*` open questions. Reference them in chat and commit messages.

---

## Read this first — what changed

This file was rewritten after a false start. Four things are settled that were not before,
and one whole category of work is deliberately deferred.

**1. The stack is TypeScript.** `Q-1` is closed. Person 1's Hermes adapter drives Hermes
as a local subprocess over **ACP** (JSON-RPC on stdio, `uv run hermes-acp`), verified
against a real install and merged to `main` in PR #1. ACP is language-agnostic, so the
control plane does not need to be Python. Persons 1 and 2 are both on TypeScript.

> Earlier docs claimed _"the design spec describes FastAPI and SQLite."_ **It does not** —
> `agentos-design.md` names no stack at all. That line was copied between four files
> unchecked and helped justify a Python build that has since been deleted. Check the
> source before repeating a constraint.

**2. Jev is reached through the VERCEL AI SDK's AI GATEWAY.** `experimental_evaluate`
from the `ai` package, model **`typesafe-ai/jev`**, credential **`AI_GATEWAY_API_KEY`**
(held in `config.providers.jev`). **Not `@typesafe-ai/sdk`**, and not the
OpenAI-compatible chat-completions endpoint — it is the AI SDK's _evaluation_ API.
Person 2's `providers/jev/live.ts` established this route; 3B's
`providers/jev/browserDecider.ts` rides the same one. Jev still returns **typed choices
and probabilities — never free text**. See [jev.md](./jev.md) and
[Track 3B](#track-3b--browser-browserbase-and-jev).

**3. Browserbase works.** Credentials are in the root `.env` and a real session has been
opened, driven and released. The facts learned are recorded under `3B-3`.

**4. 3A does not add tools yet.** See directly below.

---

## The catalog is deliberately empty — read before starting 3A

**Do not build a tool catalog yet.** Which tools exist is decided _at the hackathon_, by
which sponsor APIs are worth integrating to qualify for sponsor tracks. Picking them now
means either throwing the work away or being locked out of a track.

So 3A's job is **the plumbing, built against an empty catalog**:

- a registry that holds zero descriptors and still works
- an MCP client that can connect to a server nobody has chosen yet
- a manifest format that a new provider drops into
- `select_tool_metadata` that correctly returns nothing from nothing

When the sponsor list lands, adding a provider should be **one manifest file and one
executor binding** — minutes, not hours. That is the actual deliverable: _the speed of
adding tool number one through fifty_, not the tools.

**Consequence for acceptance:** the "50+ schemas reduce to 3–8" criterion cannot be met
until tools exist. That is expected and fine. Build the reduction machinery and prove it
with whatever is available — the browser family is real and gives 3A a genuine consumer
to test against from day one.

---

## What Person 3 owns, and what it does not

**Owned:** everything between "Jev asked for a tool family" and "the tool actually ran."
The registry, the schemas, the executors, the browser.

**Not owned — do not build these:**

| Belongs to | What                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| Person 1   | The API, the Hermes/ACP adapter, SSE, pause/resume/cancel, the approval endpoints                                |
| Person 2   | Jev itself, model routing, `build_context`, privacy labels, risk rules, `authorize_action`, approval enforcement |
| Person 4   | The dashboard, metrics, presentation, root tooling                                                               |

Person 3 exposes tools and runs them. **Person 3 never decides whether an action is
allowed.** That call is Person 2's, every time.

### The four seams

1. **`select_tool_metadata` (3A → Person 2).** Jev picks tool families; 3A returns
   candidate descriptors within them. Jev picks the final 3–8; 3A returns those schemas.
2. **`authorize_action` (Person 2 → 3A and 3B).** Before **every** tool run, the executor
   calls Person 2's gate with the exact `ToolAction`. Execute only on an explicit allow. A
   thrown error, a timeout or a missing response **blocks** — never a default-allow.
3. **Browser destination (Person 2 → 3B).** Person 2's policy decides whether a step may
   use Browserbase or must stay local. 3B builds both and uses whichever policy names. If
   policy allows neither, the step is blocked.
4. **Browser as a tool family (3B → 3A).** 3B registers browser descriptors into 3A's
   registry and supplies the executor. The browser is one family inside the registry, not
   a parallel system.

---

## Contracts to agree first — `C-1`, `C-2`, `C-3`

Write these in `packages/shared/src/tools.ts` and export from `index.ts`. Person 1 and
Person 2 both consume them.

`packages/shared/` is a **published API: additive edits only**, and its header requires
announcing changes in chat first.

### `C-1` `RiskClass` — **answered, use the repo's**

- [x] Resolved: `auto | verify | ask_human`, **no `deny`**, already defined in
      [packages/shared/src/policy.ts](../packages/shared/src/policy.ts). **Import it. Do not
      define a second enum.**
- [x] Tell Person 2 that a blocked action therefore has no risk class — the executor
      expresses denial as a thrown error / `ok: false`.

The repo's vocabulary is deliberate and stronger than the design doc's: `policy.ts` gates
on **reversibility**, a property of the action, rather than on model confidence,
_"because calibrating that is a research problem."_

### `C-2` `ToolDescriptor`

- [x] `id`, `providerId`, `family`, `description`, `schemaRef`, `transport`, `riskClass`,
      `requiredScopes`, `allowedDataLabels`, `availability`, `executorRef`, `version`,
      `simulated`, optional `credentialRef`
- [x] `schemaRef` and `credentialRef` are **pointers, never values** — full schemas and
      credentials stay local and never reach Jev
- [ ] Confirm the shape with Person 1 and Person 2 — **needs them; shipped as written.**
      Open point for Person 2: descriptors carry BOTH `allowedDataLabels` and
      `allowedContextScopes` pending `Q-5`. Collapse them if you rule otherwise.
- [x] `pnpm typecheck` passes

### `C-3` `ToolAction` and `ToolResult`

- [x] `ToolAction`: `runId`, `stepId`, `actionId`, `toolId`, `descriptorVersion`, `args`,
      `destination`, `dataLabels`
- [ ] Confirm with Person 2 that this is exactly what `authorize_action` receives —
      **needs them.** The protocol is `AuthorizeAction` in `packages/shared/src/tools.ts`;
      3B runs a stopgap over `core/risk.ts` behind it (`core/tools/authorize.ts`)
- [ ] Confirm with Person 1 that approvals bind to `actionId` + `descriptorVersion` +
      — **needs them.** The dispatcher already blocks on a descriptor-version mismatch
      `destination`
- [x] `ToolResult`: `actionId`, `ok`, `output`, `error?`, `destination`, `latencyMs`

> **Open contract question.** The design doc's data labels are `public | private | secret`,
> but `local_only` — the thing that must never reach Browserbase — is a _context scope_ on
> `ModelRoute`, a different axis. Either carry both `allowedDataLabels` and
> `allowedContextScopes`, or collapse them. **Person 2 rules.**

---

## Track 3A — Tool Registry and MCP

Build all of this against an **empty catalog**. See
[The catalog is deliberately empty](#the-catalog-is-deliberately-empty--read-before-starting-3a).

### `3A-1` The registry

- [x] Create `apps/api/src/core/tools/registry.ts`
- [x] Holds `ToolDescriptor`s in memory; **works correctly with zero of them**
- [x] Normalize IDs to `provider.operation`
- [x] Cache full schemas **separately** from short routing metadata
- [x] Mark unauthenticated/unavailable providers ineligible so they never reach Jev
- [x] Expose real vs `simulated: true` counts for Person 4
- [x] Accept registration from 3B's browser family (seam 4)

### `3A-2` MCP client — **boundary built, BLOCKED on a dependency**

You configure **existing** MCP servers; you do not write them.

`apps/api/src/core/tools/mcp.ts` defines the seam and loads
`@modelcontextprotocol/sdk` through a variable specifier. With no package
present, `discover()` returns `availability: 'unavailable'` and the registry
excludes that server from selection — the correct fail-closed behaviour, and
the same thing an unreachable server should do. `discoverToDescriptors()` fixes
the untrusted-description rule in code: the server supplies names, descriptions
and schemas; **our manifest supplies risk class, labels, scopes and executor.**
`connect()` is deliberately left unimplemented rather than guessed.

- [ ] Confirm with Person 4 (owns root tooling) before adding the MCP client dependency —
      **there is no MCP client in this repo yet**
- [ ] Wire a client that can connect to an arbitrary server given a manifest
- [ ] Verify discovery returns schemas
- [ ] Confirm an unauthenticated server reports `availability: 'unauthenticated'` and is
      excluded from selection
- [ ] **Do not pick servers yet** — that waits for the sponsor list

### `3A-3` Plugin manifest format

One file per provider. No marketplace, no installer.

- [x] Create `config/plugins/`
- [x] Define the manifest: plugin id + version, provider type, MCP endpoint or local
      command, tool metadata, credential **references**, permission scopes, privacy defaults,
      display info
- [x] Loader reads the directory at startup and registers whatever it finds
- [x] Confirm no manifest contains a credential **value**
- [x] **Prove the format by writing exactly one manifest** — the browser family, which is
      real. That validates the loader without guessing at sponsor APIs.

### `3A-4` `select_tool_metadata`

- [x] Implement in `registry.ts`
- [x] Given the families Jev chose, return candidate descriptors within them
- [x] Return routing metadata only — never full schemas, never credential values
- [x] Return full schemas for the final set Jev picks
- [x] Correct behaviour on an empty catalog: return nothing, do not throw
- [ ] Confirm the call pattern with Person 2 (see `Q-4`) — **needs them.** Both stages
      are supported today: `selectToolMetadata({families})` then `schemasFor(ids)`

### `3A-5` Executor interface and non-browser executors

- [x] Create `apps/api/src/core/tools/executor.ts`
- [x] Define the interface 3B also implements (see `S-2`) — proposed:
      `(action: ToolAction) => Promise<ToolResult>`
- [x] **Call `authorize_action` before every run**; execute only on explicit allow
- [x] Error, timeout **and missing response** all block
- [ ] Wire the MCP executor against the empty catalog
- [ ] Composio: `ToolboxAdapter` exists and mocks work; fill `live.ts` **only if** Composio
      ends up in the sponsor set

### `3A-6` Sponsor tools — **deferred, do not start**

- [ ] Wait for the sponsor API list
- [ ] Add one manifest per chosen provider
- [ ] Pad with clearly-labelled `simulated: true` fixtures **only if** the catalog is too
      thin to demonstrate reduction
- [ ] Fixtures must be **non-executable** — attempting to run one is an error, not a no-op

### 3A acceptance

- [x] The registry, loader and `select_tool_metadata` work with an empty catalog
- [x] Adding a provider is one manifest + one binding
- [x] An unavailable or unauthenticated server is excluded from selection
- [x] An unknown or unselected tool call is **blocked** at execution
- [x] Tool descriptions and outputs are treated as untrusted and cannot grant permission
- [ ] _(after `3A-6`)_ 50+ registered/simulated schemas reduce to 3–8 per step

### 3A tests

- [x] Empty catalog behaves correctly end to end
- [x] Unavailable server excluded from candidates
- [x] Unselected tool call blocked at execution
- [x] A `simulated: true` fixture refuses to execute
- [x] Task still succeeds after schema filtering

---

## Track 3B — Browser, Browserbase and Jev

### The architecture: Jev drives, and it has to be fast

This is the centre of 3B. **Jev chooses every browser action, and the design goal is one
network round trip per step.** The pattern is proven — `browser-use/jev-ultrafast` (MIT,
8k+ stars) converged on it, and [jev.md](./jev.md) documents it in full.

```
                          one TypeSafe request
                         ┌───────────────────────────┐
page → element table  →  │ operation                 │
  [1] button  Sign in    │ click_target              │
  [2] textbox Email      │ type_text_target          │
  [3] combobox Country   │ select_target, if present │
                         └─────────────┬─────────────┘
                             use the matching target
                                       │
                        CLICK [1] ─────┤──→ executor → gate → browser
                    TYPE_TEXT [2] ─────┘
                              ↓
                       small LLM → text → browser
```

Five rules that make it fast:

1. **Indexed element table, never raw DOM or screenshots.** An accessibility snapshot is
   2–5KB against 100KB+ for a screenshot, and 80–90% smaller than raw DOM. Vision tokens
   cost 3–5× text tokens. The integer index is Jev's `criteria` key.
2. **Element handles stay server-side.** Jev returns `7`, not a selector. Selectors go
   stale; handles do not.
3. **Speculative fan-out.** Ask for the operation _and_ every possible per-operation target
   in **one** request, then discard the heads that do not match. Two decisions, one round
   trip. Cost of the discarded heads is the deliberate trade — tune the head count if cost
   matters more than latency.
4. **Cache the resolved target.** On a hit, execute with **no model call at all**;
   re-invoke Jev only on a miss, then rewrite the entry. After one warm-up run the demo
   path is deterministic, fast and free — no live model nondeterminism on stage.
5. **Validate before executing.** Check document **freshness** and target **occlusion**.
   The snapshot is already stale by the time Jev answers; this is where browser agents
   get flaky.

Jev's operation vocabulary: `CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP`, `SCROLL_DOWN`,
`WAIT`, `DONE`, `BLOCKED`. Note `TYPE_TEXT` — **Jev picks the field, a small generative
model supplies the value.** Jev cannot write the text.

### `3B-1` Register the browser family

- [x] Add `'localbrowser'` to `ProviderId` and `PROVIDER_IDS`, and `'browser.local'` to
      `Capability` / `CapabilityMap`, in `packages/shared/src/providers.ts`
- [x] Add `providers.localbrowser` to `apps/api/src/config.ts`; gate on
      `LOCALBROWSER_CHANNEL`, not an API key — copy the `resolveHermes()` precedent
- [x] Register in `apps/api/src/providers/registry.ts` (`FACTORIES` + `BINDINGS`)
- [x] Register browser descriptors into 3A's registry (seam 4)

> **Why a separate capability.** `registry.ts` binds **one provider per capability**, so
> without this there is nowhere for seam 3 to live. Folding both backends into one adapter
> would collapse two egress-ledger rows into one and destroy the "local-only never reached
> Browserbase" proof. `packages/shared/` is a published API — **announce this edit.**

### `3B-2` Local browser backend

The privacy path. Without it, any `local_only` step is blocked and the privacy story has
a hole. Anything sensitive typed into a form belongs here, never in Browserbase.

- [x] `apps/api/src/providers/localbrowser/index.ts` (mock, via `mockBase`/`mockCall`) and
      `live.ts` (real Playwright)
- [x] Implements `BrowserAdapter` from `packages/shared/src/providers.ts`
- [x] Reports `destination: 'local://chromium'` — the ledger proof it stayed local
- [x] **`playwright-core` ships no browser binaries.** Use `channel: 'chrome'` against
      installed Chrome, or add the full `playwright` package
- [x] Verified by a smoke run against a real public page

### `3B-3` Browserbase backend

`apps/api/src/providers/browserbase/{index,live}.ts` already exist and use **Stagehand v4**.
Credentials are in the root `.env` and work.

- [x] Verify the existing adapter live before changing anything
- [ ] Wire the live-view URL — **code written, BLOCKED on a dependency.**
      `@browserbasehq/sdk` is in the pnpm store as a transitive dep of Stagehand but is not
      _declared_, so pnpm's strict layout will not resolve it. One command unblocks it:
      `pnpm --filter @htn/api add @browserbasehq/sdk` (dependency owner's call). The
      capture path, including the 410-Gone timing, is already in `browserbase/live.ts`.
      Original note: currently hardcoded `undefined`. Needs `@browserbasehq/sdk`
      `client.sessions.debug(id).debuggerFullscreenUrl`. The UI already has a slot
- [x] Cap concurrency to `BROWSER_MAX_SESSIONS`
- [x] Handle errors and timeouts without leaking a session

**Facts already established against the live API — do not re-derive these:**

| Fact                                                                                      | Consequence                                                                                                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Concurrency limit is **25** (`projects.list().concurrency`)                               | default `BROWSER_MAX_SESSIONS=2`; raise only if the demo needs parallel browsers                                          |
| Session **replay/recording API is deprecated** — returns `404`                            | **Person 4 cannot use replay as demo evidence.** Use the live-view URL during the session plus our own `ToolResult` trace |
| Egress host is **region-specific** (`connect.usw2.browserbase.com`, not the generic host) | approvals bind to destination, so bind to the **per-session** value or pin `region` on create                             |
| Live-view URL returns **`410 Gone`** once the session stops                               | capture it **while the session is open**; it cannot be fetched after                                                      |
| `REQUEST_RELEASE` works — sessions reach `COMPLETED`, none left `RUNNING`                 | release on every exit path or you burn a slot and money                                                                   |

### The Browserbase privacy rule

**Browserbase is a remote data recipient.** Local-only data never goes to a cloud model,
remote Jev, Browserbase, or a remote tool. Anything typed into a Browserbase page has left
the machine — inputs, screenshots and cookies alike.

- [x] Browserbase descriptors exclude `local_only` context and `secret` data labels
- [x] Encode this **in the descriptor**, not in a runtime check that can be skipped

### `3B-4` The element table — the Jev seam

- [x] Build an indexed table of **interactive elements only** from an accessibility
      snapshot
- [x] Hold live element handles server-side, keyed by index
- [x] Shape the table into Jev `Choice` `criteria` (integer keys)
- [ ] **Stagehand's `observe()` is the shortcut** — it already returns candidate elements
      with descriptions, which is most of this work, and it is already a dependency
- [x] Keep it small: interactive elements only, truncated labels

### `3B-5` The Jev decision call

- [x] One `evaluate()` request per step carrying operation + speculative targets, in
      `providers/jev/browserDecider.ts`. Same batched shape Person 2's `route()` uses
      (privacy + intelligence + one question per tool, all in one call)
- [x] Use the **Vercel AI SDK through the AI Gateway** (`experimental_evaluate`, model
      `typesafe-ai/jev`), reading Person 2's `config.providers.jev` slot so there is one
      Jev route and one place to configure it. `ai` is a declared dependency and the code
      is written and typechecks. **Not yet run against a real `AI_GATEWAY_API_KEY`**, so
      every browser decision today comes from the deterministic fallback and is labelled
      `deterministic` in the trace.
- [x] **Deterministic fallback when there is no key** — string-match the intent against
      candidate labels. The design doc requires a deterministic Jev fallback anyway, so this
      is not throwaway work, and it keeps the demo runnable with zero credentials
- [x] Feed `confidence` / `probabilities` into the risk gate: **low confidence escalates**
      a `verify` action to `ask_human`, never the reverse
- [x] Resolution cache keyed on page + intent; a hit makes **zero** model calls
- [x] Freshness and occlusion checks before executing the chosen target

### `3B-6` Browser executor

- [x] `apps/api/src/core/tools/browser.ts`, implementing 3A's executor interface (`S-2`)
- [x] Map a `ToolAction` onto `openSession` / `act` / `extract` / `closeSession`
- [x] **Call `authorize_action` before every run.** Block on deny, thrown error, timeout
      **and missing response** — four paths, all fail closed
- [x] Select the backend from **Person 2's authorization result, never from config**
- [x] Block the step when policy allows neither backend
- [x] Run `revisedArguments` when present — never the payload a human just edited away

> There is no `authorize_action` in TypeScript yet. `core/risk.ts` has synchronous
> `classify(action: ProposedAction)` and `core/approvalGate.ts` has `waitForApproval`.
> 3B may write one thin `authorizeAction(action: ToolAction)` wrapper over them, **clearly
> marked as a stopgap for Person 2 to take over**. Do not put risk logic in the executor.
>
> **Gap for Person 1 and Person 2:** `orchestrator.ts` does
> `if (decision.riskClass !== 'ask_human') return;` — **`verify` is not implemented.** It
> proceeds exactly like `auto`. That is an acceptance criterion silently unmet.

### `3B-7` Session lifecycle

Sessions burn concurrency and money while open.

- [x] **`try/finally` around every session** — TypeScript has no `async with`
- [x] Close on success, on error including mid-action, and on cancellation
- [ ] Coordinate cancellation with Person 1's cancel endpoint — **needs them.** The
      executor already threads an `AbortSignal` and releases in `finally` on abort
- [x] No leaks across 10 consecutive runs
- [x] `core/playbooks/demo.playbook.ts` opened a session with **no `try/finally`** and
      leaked on error — **fixed.** The swarm worker now releases in a `finally`, so N
      workers can no longer leak N live sessions when an extract throws

### 3B acceptance

- [x] The agent searches, opens and extracts live public information
- [ ] **Jev chooses every browser action**, in one round trip per step — the one-request
      shape is built; the DETERMINISTIC fallback is what actually decides today, and the
      trace labels it `deterministic` rather than pretending otherwise
- [x] A cached path replays with zero model calls
- [ ] One external side effect pauses for approve, reject and revised-payload, then
      resumes — approve / reject / revised-payload are all proven at the executor
      (`check:browser-tools` §1, §4); the resume half runs through Person 1's endpoints and is
      not wired yet, so an `ask_human` action currently DENIES rather than blocking
- [x] Local-only data never reaches Browserbase
- [x] Sessions always close

### 3B tests

- [x] All four fail-closed paths block (deny, throw, timeout, missing response)
- [x] A local-only step never opens a Browserbase session
- [x] A session closes after an error mid-run, and on cancellation
- [x] A revised payload is what actually executes
- [x] Jev's choice is constrained to the offered candidate list
- [x] Low Jev confidence escalates rather than proceeding
- [x] Browser reliability across 10+ repeated runs

---

## The 3A/3B seam

**The browser is one tool family inside 3A's registry.** Not a parallel system.

- **3A owns** the `ToolDescriptor` shape, the registry, selection, and the rule that every
  executor calls `authorize_action`.
- **3B owns** the browser's descriptors, its executor, both backends, and the Jev call.
- **3B registers into 3A's registry.** No second catalog.

Agree these on day one:

- [x] `S-1` `ToolDescriptor` / `ToolAction` / `ToolResult` (`C-2`, `C-3`)
- [x] `S-2` The executor interface — proposed `(action: ToolAction) => Promise<ToolResult>`
- [x] `S-3` Browser tool IDs: `browser.search`, `browser.open`, `browser.extract`,
      `browser.click`, `browser.type`, `browser.submit`, plus `browser.inspect` for the
      element table

Because 3A starts with an empty catalog, **the browser family is 3A's first and only real
consumer for a while.** That is useful: it exercises registration, selection and execution
end to end before any sponsor tool exists.

---

## Repo reality

| Design doc says                            | Repo has                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| No stack named                             | TypeScript + Express + in-memory store. **`Q-1` resolved: TypeScript.**                                             |
| `ToolDescriptor`, `ToolAction`             | Neither exists. You write them (`C-2`, `C-3`).                                                                      |
| `action_policy: auto/verify/ask_user/deny` | `RiskClass = auto/verify/ask_human`, no `deny` — **the repo's wins** (`C-1`). `verify` is not actually implemented. |
| MCP client                                 | None. New dependency (`3A-2`), Person 4's call.                                                                     |
| Local browser path                         | Not written (`3B-2`). `playwright-core` is installed but ships no binaries.                                         |
| Browserbase                                | Stagehand v4 adapter exists; credentials work; live-view URL unwired.                                               |
| Jev                                        | `providers/jev/{index,live}.ts` exist. API shape now known — see [jev.md](./jev.md).                                |

**What already works:** every provider falls back to a mock with no API keys, so `pnpm dev`
runs the full demo today. Build against mocks first and flip one `<PROVIDER>_MODE=live` at
a time. Note a missing key **silently downgrades `live` to `mock`** rather than failing —
make sure the UI reports the mode that actually took effect.

Useful commands:

```bash
pnpm dev        # api on :8787, web on :5173
pnpm typecheck  # all packages
pnpm smoke      # end-to-end against a running api
pnpm format     # prettier
```

Conventions that will bite you: ESM with **`.js` extensions on relative imports**;
**`verbatimModuleSyntax`** so type-only imports must say `import type`; the
**`ProviderCallContext` must be the last argument** of every adapter method or
`withEgress` silently misses the ledger row; **never call egress inside an adapter** — the
registry's Proxy does it; **vendor SDK types never escape `live.ts`**.

Two traps documented in the README that cost an hour each: **never add `compression()` to
the Express app** (it silently breaks SSE), and **a step's `output` is streamed and
stored** — return metadata about a document, never the document itself.

---

## Open questions

### `Q-1` Express or FastAPI?

- [x] Answered — **TypeScript/Express.** Person 1's Hermes/ACP adapter is merged and
      verified; ACP over stdio is language-agnostic, so the control plane need not be Python.
      The competing claim that the design doc mandated FastAPI was false.

### `Q-2` `ask_human` or `ask_user`, and is there a `deny`?

- [x] Answered — **`auto | verify | ask_human`, no `deny`.** Already defined in
      `packages/shared/src/policy.ts`; import it, do not redefine. Denial is expressed as a
      thrown error / `ok: false`.

### `Q-3` Which providers are live for the demo?

- [x] Answered — **deferred by design.** Tool providers are chosen at the hackathon based
      on which sponsor APIs are worth integrating for sponsor tracks. 3A builds the plumbing
      against an empty catalog until then. The browser family is live regardless.

### `Q-4` Does Jev pick families then tools, or is `select_tool_metadata` called once?

- [ ] Answered — **Answer:** _(unanswered — confirm with Person 2.)_

  Now partly informed by Jev's actual API: many questions batch into **one** request, and
  latency is per-request. So a two-stage selection costs two round trips where a single
  batched call might do both. Worth raising with Person 2 before 3A commits.

### `Q-5` Is `local_only` a data label or a context scope?

- [ ] Answered — **Answer:** _(unanswered — Person 2 owns it.)_ See the note under `C-3`.
