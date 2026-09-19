# HTN 2026 — Agent Runtime Scaffold

A supervised agent runtime: kick off a long-running task, watch it work in real time,
and it stops for a human before anything irreversible.

**The product idea is not decided yet, and this scaffold does not assume one.** Nothing
above `core/playbooks/` is named after a product. Choosing the idea means adding one
playbook file, one zod schema, and one result card — not restructuring the app.

## Quick start

```bash
pnpm install && pnpm dev
```

Then open http://localhost:5173 and click **Launch**.

There is no `.env` step. With no API keys at all, every provider falls back to a mock and
the full demo runs end to end. That is deliberate, not a placeholder.

| Command          | What it does                          |
| ---------------- | ------------------------------------- |
| `pnpm dev`       | api on :8787 and web on :5173         |
| `pnpm typecheck` | all three packages                    |
| `pnpm smoke`     | end-to-end test against a running api |
| `pnpm format`    | prettier                              |

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

## Shipping the product idea

1. `packages/shared/src/schemas/playbooks/<kind>.ts` — the zod input schema
2. Add one line to `packages/shared/src/schemas/playbooks/index.ts`
3. `apps/api/src/core/playbooks/<kind>.playbook.ts` — copy `demo.playbook.ts` and rewrite the steps
4. Add one line to `apps/api/src/core/playbooks/registry.ts`

Nothing else changes. Not the store, not the routes, not the streaming, not the UI chrome.

## Going live with a provider

Every provider has `index.ts` (factory + mock) and `live.ts` (a stub that throws
`NOT_IMPLEMENTED` with instructions in its header).

> **The Hermes and Jev live adapters are intentionally unimplemented.** Their real
> endpoints, auth, and payload shapes were not known when this was scaffolded and were
> **not guessed** — invented code that compiles and looks finished is worse than a stub
> that tells you what to ask for. Get the docs from the sponsors and fill in `live.ts`.
> Map their shapes onto our interfaces; vendor types must not escape that file.

Recommended order, lowest risk first: **Anthropic** → **Browserbase** → **Composio** →
**Jev** → **Hermes**. Flip one `<PROVIDER>_MODE=live` at a time. Anything not working by
hour 30 stays mocked; the app does not care.

Two things to confirm at the Browserbase booth in hour one: your **concurrent session
limit** (the swarm design depends on it — cap `fanOut` concurrency to match) and whether
session recordings are retrievable (free demo evidence).

## Demo-day switches

| Env                     | Effect                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `MOCK_ALL=true`         | Forces every provider to mock. **Rehearse the demo with this on at least once — it is your venue-wifi insurance.** |
| `MOCK_FAILURE_RATE=0.2` | Mocks fail randomly, so error states get built before keys land                                                    |
| `PERSIST_TO_DISK=true`  | Debounced JSON snapshot to `.data/`, so runs survive an api restart                                                |

## Things that will bite you

- **Never add `compression()` to the Express app.** gzip buffering silently breaks SSE and
  the symptom looks like a hung backend.
- **Express 5 rejects bare `*` routes** (path-to-regexp v8). Use `/*splat`.
- **A step's `output` is streamed and stored.** Never return a raw document from a step —
  return metadata about it and keep the document in a local variable. `pnpm smoke` asserts this.
- **`req.query` is getter-only in Express 5.** Validated data lands on `req.valid`.

## Deliberately skipped

Docker · CI · auth · a database · TS project references · ESLint · pre-commit hooks ·
a state-management library · Next.js. Each is a known hackathon time sink. The only test is
`scripts/smoke.mjs`.
