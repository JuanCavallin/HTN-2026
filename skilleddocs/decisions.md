# Decisions

Append-only register of decisions made in grilling sessions, consult-plan
reviews, and orchestrator runs. Reverse a decision by adding a new row that
says so; never edit an old row.

| # | Date | Decision | Why | Source |
|---|------|----------|-----|--------|
| D1 | 2026-09-23 | Target audience is external teams (a product), not a portfolio or internal tool. | Sets the bar for auth, tenancy, policy, reliability. | grills/2026-09-23-backend-extension-plan.md#Q1 |
| D2 | 2026-09-23 | Tenancy v1 = one API key per team; `owner_id` on every tenant-scoped table; users/orgs later. | Column + middleware now; users/orgs layer on without touching store methods again. | grills/2026-09-23-backend-extension-plan.md#Q2 |
| D3 | 2026-09-23 | An in-process OpenAI-compatible tool-loop adapter becomes the primary harness; Hermes stays as the external-harness demo; gateway surfaces kept clean so bring-your-own-harness falls out later. | Subprocess-per-session is a hard sell to deploy; in-process is CI-testable and makes mock mode a real agent. | grills/2026-09-23-backend-extension-plan.md#Q3 |
| D4 | 2026-09-23 | The run/graph/playbook layer stays a maintained product surface alongside the gateway. | Doubles surface area, accepted. | grills/2026-09-23-backend-extension-plan.md#Q4 |
| D5 | 2026-09-23 | Phase 0 (policy bypass fixes) is a hard gate: one PR, nothing else merges first. | Bypasses would end up in a security write-up for an external product. | grills/2026-09-23-backend-extension-plan.md#Q5 |
| D6 | 2026-09-23 | Auth lands at the end of Phase 1, as migration 001 on top of the migration runner. | Avoids a second `PRAGMA table_info` hack. | grills/2026-09-23-backend-extension-plan.md#Q6 |
| D7 | 2026-09-23 | The in-process adapter is Phase 1 item 0; all other Phase 1 reliability work assumes it. Hermes gets only fixes 0.7/0.8. | Do not harden plumbing about to be demoted. | grills/2026-09-23-backend-extension-plan.md#Q7 |
| D8 | 2026-09-23 | The adapter is a real HTTP client of `/v1` + `/mcp` over loopback, not an in-process call. | Doubles as the BYO-harness contract test in CI. | grills/2026-09-23-backend-extension-plan.md#Q8 |
| D9 | 2026-09-23 | `POST /api/sessions` (mint gateway tokens without a run) is public and documented in Phase 1; the adapter is its first client. | Zero extra cost; lets any external loop point at Zephyr. | grills/2026-09-23-backend-extension-plan.md#Q9 |
| D10 | 2026-09-23 | A BYO session is a `Run` of kind `external`: no orchestrator loop, terminal via `POST /runs/:id/complete` or token TTL. | Reuses approvals, ledger, stream, compare unchanged. | grills/2026-09-23-backend-extension-plan.md#Q10 |
| D11 | 2026-09-23 | Merge `krish/edit-running-workflow-node` right after the `actionKind` fix, adding a `node.edited` before/after + re-classified-risk event; edits allowed while paused. | Clean 5-commit branch should not rot. | grills/2026-09-23-backend-extension-plan.md#Q11 |
| D12 | 2026-09-23 | Privacy now = gateway redaction (2.1) + imported tool outputs (2.5) only; rehydration, ledger v2, new detectors deferred. | Closes the pitch/code gap and a functional blocker; the rest waits for a consumer. | grills/2026-09-23-backend-extension-plan.md#Q12 |
| D13 | 2026-09-23 | Policy packs first cut = budgets + tool allow/deny + approval amount threshold, per tenant; risk-vocabulary merge first. | Budgets are the day-one ask; residency/label matrices wait for a customer. | grills/2026-09-23-backend-extension-plan.md#Q13 |
| D14 | 2026-09-23 | Delegated: approval notifications = webhook only (HMAC); retention 30 days with PII purge at terminal status; escalation cheap→frontier within the same privacy class; tests on `node:test`; deploy = one container + SQLite volume. | User said "go with your recs for the remaining". | grills/2026-09-23-backend-extension-plan.md#delegated |
| D15 | 2026-09-23 | Kanban board lives under user KrishP147 (project 4, "HTN-2026 Board"), issues in JuanCavallin/HTN-2026; `AGENTS.md` overrides the board lookup. | Repo owner has no projects and only the owner can create one under their account. | this session (chat) |
| D16 | 2026-09-23 | The 36 plan issues (#9–#44) with `lane:*`, `phase:*`, `size:*` labels are the approved backlog; four lanes follow file ownership so four people work in parallel. | User approved the preview. | this session (chat), docs/backend-extension-plan.md "Board and issue map" |
| D17 | 2026-09-23 | Skill-produced documents (decisions, grills, handoffs, orchestrator ledger, reports) live in `skilleddocs/` in this repo and are committed. | One record for humans and agents; survives machines. | this session (chat); skills repo README "Where skills write" |
