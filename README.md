# HTN 2026 — AgentOS

A harness-agnostic control plane that makes AI agents faster, cheaper, more private,
and easier to supervise. Hermes is the first harness adapter for the demo; Jev selects
the model route, context scope, and relevant tools for each step and helps determine
whether the task is complete from canonical session state.

Deterministic AgentOS policy remains the final authority for privacy, authorization,
verification, and irreversible actions. See the
[final design specification](docs/agentos-design.md) for the product contract and MVP.

## Quick start

```bash
pnpm install && pnpm dev
```

Then open http://localhost:5173 and click **Launch**.

There is no `.env` step. With no API keys at all, every provider falls back to a mock and
the full demo runs end to end. That is deliberate, not a placeholder.

| Command                    | What it does                              |
| -------------------------- | ----------------------------------------- |
| `pnpm dev`                 | api on :8787 and web on :5173             |
| `pnpm typecheck`           | all three packages                        |
| `pnpm smoke`               | end-to-end test against a running api     |
| `pnpm check:providers`     | live Ollama + provider wiring check       |
| `pnpm check:browser-tools` | browser policy/executor integration check |
| `pnpm format`              | prettier                                  |

## What it already does

- **Steps** — a run is a sequence of steps, streamed live over SSE
- **Swarm** — `ctx.fanOut()` runs N workers in parallel as child steps; the UI renders the grid automatically
- **Risk gate** — actions are classified by **reversibility**, and irreversible ones block on human approval
- **PII redaction** — sensitive spans are detected, pinned local, and replaced with `[[PII_n]]` before anything reaches a cloud provider
- **Egress ledger** — every outbound call is recorded with its destination, the _class_ of data it carried, and the rule that allowed it

## Layout

```
packages/shared     types + zod schemas — imported by BOTH web and api
apps/api/src/
  api/              HTTP only. Knows req/res, knows no providers.
  core/             Pure domain + orchestration. No express, no fetch, no store import.
    playbooks/      <- THE PIVOT SEAM
  services/         Use-cases. Wires core + store + providers.
  providers/        The only place fetch/SDKs are allowed.
  store/            The only place data is held.
apps/web/src/       React + Vite SPA
```

**Dependency rule:** `api → services → core`, plus `services → providers` and
`services → store`. `core` imports nothing outward — it receives what it needs as
arguments. That rule is what keeps the orchestrator testable and the app pivot-safe.

## Who owns what

| Dev            | Directory                                                            | Notes                                                         |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| A — Frontend   | `apps/web/**`                                                        | Never blocked; can dispatch fake `RunEvent`s into the reducer |
| B — Agent core | `apps/api/src/core/**`                                               | Works entirely against mocks                                  |
| C — Providers  | `apps/api/src/providers/**`                                          | Mocks first, then fill `live.ts` from sponsor docs            |
| D — Platform   | `apps/api/src/{api,services,store}`, `packages/shared`, root tooling | Owns dependency additions                                     |

`packages/shared/src/domain.ts` is the one genuinely shared file. Treat it as a published
API: **additive edits only**, and say so in chat before changing an existing field.
Only D adds dependencies — resolve `pnpm-lock.yaml` conflicts by taking either side and
re-running `pnpm install`, never by hand-merging.

## Shipping the AgentOS demo playbook

1. `packages/shared/src/schemas/playbooks/<kind>.ts` — the zod input schema
2. Add one line to `packages/shared/src/schemas/playbooks/index.ts`
3. `apps/api/src/core/playbooks/<kind>.playbook.ts` — copy `demo.playbook.ts` and rewrite the steps
4. Add one line to `apps/api/src/core/playbooks/registry.ts`

Nothing else changes. Not the store, not the routes, not the streaming, not the UI chrome.

## Going live with a provider

Every provider has an internal adapter boundary. Hermes, Jev, Browserbase, local Chrome,
OpenRouter, Ollama, and Composio have live paths; Anthropic remains the legacy bound
text-model fallback. Browser tools, Composio tools, and generic MCP tools all enter the
same reviewed registry and exact-action broker before Hermes can call them. Vendor types
must not escape provider files.

Flip one `<PROVIDER>_MODE=live` at a time. Anything not working by hour 30 stays mocked;
the app does not care.

### Testing Jev through Vercel AI Gateway

Set `JEV_MODE=live` and `AI_GATEWAY_API_KEY` in the ignored root `.env`, then run:

```bash
pnpm test:jev
```

The test verifies Gateway authentication, one typed Jev decision, and model/tool routing
through the same live adapter used by the API. Jev uses model ID `typesafe-ai/jev` through
AI SDK's evaluation API; it is not a chat-completions model.

To test Jev's model-tier routing against three built-in task prompts:

```bash
pnpm test:jev:routing
```

Or evaluate your own sanitized task description:

```bash
pnpm test:jev:routing -- "Read my resume and summarize my experience"
pnpm test:jev:routing -- "Search current software jobs at Google"
```

Jev makes two independent decisions from the task description: `privacy` is `private` or
`cloud`, and `intelligence` is `low` or `high`. Together these map to a small private
model, strong private model, inexpensive cloud model, or frontier cloud model. Both axes
default to `auto`; `--privacy` and `--intelligence` remain available as explicit test
overrides. Do not put actual secrets or personal data in a Gateway test prompt.

Browserbase sessions use the configured concurrency cap. Its live-view URL is captured
while a session is open; completed-session replay is not assumed to be available.

## Demo-day switches

| Env                     | Effect                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `MOCK_ALL=true`         | Forces every provider to mock. **Rehearse the demo with this on at least once — it is your venue-wifi insurance.** |
| `MOCK_FAILURE_RATE=0.2` | Mocks fail randomly, so error states get built before keys land                                                    |
| `PERSIST_TO_DISK=true`  | SQLite persistence in `.data/`, so control-plane history survives API restarts                                     |
| `SQLITE_PATH=...`       | Optional SQLite path resolved from `apps/api` (default `../../.data/agentos.sqlite`)                               |

## Things that will bite you

- **Never add `compression()` to the Express app.** gzip buffering silently breaks SSE and
  the symptom looks like a hung backend.
- **Express 5 rejects bare `*` routes** (path-to-regexp v8). Use `/*splat`.
- **A step's `output` is streamed and stored.** Never return a raw document from a step —
  return metadata about it and keep the document in a local variable. `pnpm smoke` asserts this.
- **`req.query` is getter-only in Express 5.** Validated data lands on `req.valid`.

## Deliberately skipped

Docker · CI · application auth · TS project references · ESLint · pre-commit hooks ·
a state-management library · Next.js. Each is a known hackathon time sink.
