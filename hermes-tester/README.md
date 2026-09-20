# hermes-tester

A throwaway connectivity test, not part of the real product. It exists to prove the
Hermes/ACP connection works from an actual UI, in isolation from the real Jev
integration a teammate is building.

**Scope, deliberately narrow:** this proves "can we prompt Hermes and get a real
response back," nothing more. Tool eligibility is a hardcoded preset list
(`mockJev.mjs`), not a real routing decision. It does not import
`apps/api/src/providers/jev/**` or `packages/shared` — zero conflict risk with that
work, and it isn't part of the pnpm workspace, so `pnpm install` at the repo root never
touches it.

## Run

```bash
cd hermes-tester
npm install
npm start
```

Then open http://localhost:5055 and type a prompt.

Edit `HERMES_DIR` at the top of `server.mjs` if your `hermes-agent` clone lives
somewhere other than `<path-to>/hermes-agent`.

## What it does

- Spawns `uv run hermes-acp` once, on server startup, and keeps that one session alive
  for every prompt you send — not a new process per message.
- Auto-approves any permission request Hermes raises (`allow_once`). There's no
  interactive terminal attached to answer it here. **Never do this in the real
  product** — that's exactly the job `core/approvalGate.ts` already does properly.
- Attempts to scope Hermes's toolset to the mock's preset list via ACP's `_meta`
  field on session creation. This is a documented ACP extension point, but whether
  Hermes's server actually reads `enabled_toolsets` out of it is **unconfirmed** —
  check the `tool_search activated (tier N): X kept` line in the terminal log to see
  if the kept-tool count changes versus a run without it. Harmless either way; the
  chat round-trip works regardless.

## When you're done with it

Delete this folder, or leave it — it's fully self-contained and touches nothing else
in the repo.
