# Grill: backend extension plan

Date: 2026-09-23 · Subject: `docs/backend-extension-plan.md` · Status: settled

Context: the plan was drafted from four parallel subsystem audits (runtime, gateways/policy, tools/browser, store/API/graph/tests) of `apps/api` after the Hack the North 2026 hackathon. The user asked for the questions one at a time. Recorded after the fact by the session that ran the interview (the `grill-docs` skill did not exist yet).

## Rounds

### Q1 — Who is this for now?
- Asked: (a) portfolio / continued learning, (b) internal tool run daily, (c) product for other teams.
- Recommended: (b).
- Answer: (c).
- Why: not stated.

### Q2 — Tenancy model
- Asked: (a) one API key per team, (b) users + orgs from day one, (c) bring-your-own identity behind a proxy.
- Recommended: (a).
- Answer: (a).
- Why: not stated.

### Q3 — Is Hermes still the bet?
- Asked: (a) Hermes primary, second adapter proves the boundary; (b) in-process OpenAI-compatible tool-loop primary, Hermes as demo; (c) no bundled loop, Zephyr is only the gateway pair + policy.
- Recommended: (b) now, keep gateways clean so (c) falls out.
- Answer: (c) at first, then corrected to (b) "go with your rec".
- Why: (c) is the eventual product shape; (b) is the practical step.

### Q4 — What happens to the run/graph/playbook layer?
- Asked: (a) keep as a maintained second product surface, (b) freeze, (c) reference client only, (d) delete.
- Recommended: (c).
- Answer: (a).
- Why: not stated.

### Q5 — Phase 0 as a hard gate?
- Asked: (a) hard gate, one PR; (b) interleave with a visible feature; (c) fold into later phases.
- Recommended: (a).
- Answer: (a).
- Why: not stated.

### Q6 — Where does auth land in the sequence?
- Asked: (a) first Phase 1 item, (b) end of Phase 1 after the migration runner, (c) stays in Phase 3.
- Recommended: (b).
- Answer: (b).
- Why: not stated.

### Q7 — Adapter before or after Phase 1 reliability?
- Asked: (a) adapter first then Phase 1, (b) Phase 1 against Hermes then adapter, (c) adapter is Phase 1 item 0 and the rest assumes it.
- Recommended: (c).
- Answer: (c).
- Why: not stated.

### Q8 — Does the adapter go through the gateways over HTTP or call core directly?
- Asked: (a) real HTTP client over loopback, (b) in-process calls, (c) in-process with an HTTP flag for tests.
- Recommended: (a).
- Answer: (a).
- Why: not stated.

### Q9 — Expose session minting as a public API now?
- Asked: (a) public + documented in Phase 1, (b) internal only, (c) skip.
- Recommended: (a).
- Answer: (a).
- Why: not stated.

### Q10 — How does a BYO session show up in the store and UI?
- Asked: (a) a `Run` of kind `external`, (b) new `Session` entity, (c) flag on the agent playbook.
- Recommended: (a).
- Answer: (a).
- Why: not stated.

### Q11 — Node-edit branch
- Asked: (a) merge after the `actionKind` fix with a `node.edited` event, (b) hold until Phase 3 narrow-only semantics, (c) merge as-is.
- Recommended: (a); allow edits while paused.
- Answer: (a).
- Why: not stated.

### Q12 — Privacy scope (Phase 2)
- Asked: (a) full Phase 2 before policy packs, (b) only gateway redaction + imported tool outputs, (c) defer all and soften README.
- Recommended: (b).
- Answer: (b).
- Why: not stated.

### Q13 — Policy packs scope
- Asked: (a) full Policy record, (b) budgets + tool allow/deny + approval threshold per tenant, (c) JSON file per tenant.
- Recommended: (b), vocabulary merge first.
- Answer: (b).
- Why: not stated.

### Delegated — remaining questions
- Asked: approval notification channel; retention default; escalation policy; test framework; deploy target.
- Recommended: webhook only (HMAC); 30 days + PII purge at terminal status; cheap→frontier within the same privacy class; `node:test`; one container + SQLite volume.
- Answer: (delegated) as recommended.
- Why: user said "go with your recs for all the remaining questions".

## Summary

- Product for external teams; per-team API key + `owner_id` now, users/orgs later.
- In-process HTTP-client adapter becomes the primary harness and the BYO contract test; Hermes demoted to demo.
- Public `POST /api/sessions`; BYO sessions are `external` runs.
- Phase 0 hard gate → merge node-edit → Phase 1 (adapter first, auth last) → Phase 2 (redaction + tool outputs) → Phase 3 (minimal policy packs + budgets).
- Workflows layer stays a product surface.

## Open

None. Board-owner and issue approval recorded as D15–D16 in `../decisions.md`.
