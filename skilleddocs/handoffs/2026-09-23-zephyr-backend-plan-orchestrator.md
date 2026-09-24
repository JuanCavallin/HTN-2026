# Handoff: backend extension plan → orchestrator run

Date: 2026-09-23 (EDT) · From: planning session (Fable, Claude Code) · For: `/meta-orchestrator <zephyr path>`

## State

- Repo `JuanCavallin/HTN-2026`, default `main`, clone `C:\Users\User\zephyr`.
  This handoff and the files below were committed on branch `krish/backend-plan`
  (PR opened; merge it first, or start the orchestrator from that branch).
- Plan: `docs/backend-extension-plan.md` — 5 phases, 4 lanes, issue map.
- Decisions D1–D17: `skilleddocs/decisions.md`. Transcript:
  `skilleddocs/grills/2026-09-23-backend-extension-plan.md`.
- Board: https://github.com/users/KrishP147/projects/4 — 36 issues #9–#44, all
  Todo, labelled `lane:*`, `phase:*`, `size:*`, `status:todo`. Overrides for
  every kanban skill are in `AGENTS.md` "Workflow skills: Zephyr overrides"
  (board owner `KrishP147`, project 4, field/option ids).
- Worktrees: `C:\Users\User\_worktrees\zephyr-node-edit` on
  `krish/edit-running-workflow-node` (5 commits, merges clean; issue #16 says
  when and how to merge it — after #13). `C:\Users\User\_worktrees\zephyr-quickwin`
  on `krish/delete-temp-risk-table` has no commits beyond an old main; delete it.
- CI: `.github/workflows/ci.yml` runs `pnpm typecheck`, `pnpm test`, `pnpm build`.
  `pnpm smoke` needs a running API (manual). Last known state of `main`: green.

## What the orchestrator should do first

1. Phase 0, hard gate (D5): #9 (lane A), #10 #11 (B), #12 (C), #13 #14 #15 (D).
   All `size:S`. One manager per lane in parallel, separate worktrees. They may
   share one PR per lane or one PR total; every fix needs a negative test in the
   named check suite. Then #16 (merge node-edit branch) after #13.
2. Only then Phase 1: start with #17 (in-process adapter, lane A, D3/D7/D8) and
   #37 (migration runner, lane D) in parallel; #24 (risk vocabulary merge, lane B)
   waits for #13 and #14; #31 (lane C) is independent.
3. Read "Depends on: #n" in each issue body before briefing it.

## Scope contract suggestions (§0.4)

`execution: pair` · `handoff_budget: 10` · reports `skilleddocs/reports/` ·
exclusions: none · merge: merge commit · interview authorization: yes, from
`skilleddocs/decisions.md` (log every Q→A) · branch prefix `krish/` ·
never: live provider keys, outbound sends, deleting data, `git push --force`.

## Gotchas

- Never add `compression()` to the Express app (breaks SSE). Express 5:
  `/*splat`, `req.valid` not `req.query`. Full list in README "Things that will bite you".
- `pnpm test` is one `&&` chain of ~14 `tsx` boots; first failure hides the rest
  (fixing that is #40). Run a single suite with `pnpm --filter @htn/api check:<name>`.
- `docs/agentos-design.md` and `AGENTS.md` safety invariants are non-negotiable;
  Phase 0 exists because the code drifted from them.
- Windows: Git Bash for `pnpm` scripts; `node:sqlite` needs Node ≥ 22.13.
- Two competing risk vocabularies (`core/risk.ts` vs `core/decisions/eligibility.ts`)
  until #24 lands; don't add a third.

## Suggested skills

`meta-orchestrator` (this run) · `next` · `pair` (single issue) ·
`progress-report skilleddocs/reports` · `consult-plan` for any deviation from the plan.
