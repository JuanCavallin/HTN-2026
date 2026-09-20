# Contract — pausing a run and editing a node mid-flight

**Status:** partially implemented. Pause/resume (Person 1) is done. Mid-run node editing —
resume with `revisions`, re-authorization of the edit, and versioned-snapshot recording —
is still proposed and not built. See the status note under each section below.
**Written by:** Person 3 / track 3B, from the dashboard side.
**Owners of the work:** Person 1 (run lifecycle, endpoints, snapshot versioning),
Person 2 (`authorize_action` on the revised node).

The dashboard already ships the whole interaction. In preview it runs for real; on a live
run the same control is present, **disabled**, and states the reason. When the endpoints
below exist, `RUN_CAPABILITIES` in `apps/web/src/lib/workspace.ts` flips and the UI lights
up with no rewrite.

---

## Why this needs a contract rather than a patch

`apps/api/src/services/runs.service.ts:71-79` snapshots the graph document at run start.
The comment says why: _"Without this, editing a graph would retroactively change what an
already-finished run did."_

That snapshot is the guarantee the observability pitch rests on — a finished run's trace
answers "what actually ran", not "what the graph says today". Two consequences:

1. `PATCH /graphs/:id/nodes/:nodeId` works, but a mid-run edit has **zero effect on the
   running execution**. The runtime reads `input.graphSnapshot`, not the live document.
   Still true today — this route edits the graph document, not a run's snapshot.
2. There is **no pause or resume route**. The run API exposes `POST /runs/:id/cancel` and
   the approval endpoints, and nothing else. `core/orchestrator.ts` has no pause logic.
   **No longer true — implemented.** `POST /runs/:id/pause` and `/resume` exist
   (`apps/api/src/api/runs.routes.ts`), backed by the cooperative latch in
   `core/pauseGate.ts` and checked at step boundaries in `core/orchestrator.ts`
   (`waitWhilePaused`). Plain resume (no revisions) works end to end.

So mid-run editing cannot be delivered by routing around the snapshot. It needs the run to
stop at a safe point — done — and it needs the snapshot to be **versioned, not
mutated** — not done: `resume` does not accept a `revisions` body, so there is no
node-level edit-and-reauthorize path yet.

---

## Person 1 — run lifecycle

### `POST /runs/:id/pause`

**Implemented**, with one deviation from the spec below noted inline.

Brings the run to a resumable quiescent state.

- Succeeds only from `running`. From `awaiting_approval` it is a no-op success (the run is
  already stopped at a gate); from any terminal status it is `409`. **As built:**
  `services/runs.service.ts` `pauseRun()` checks `isTerminal()` (throws, mapped to an
  error status) and `orchestrator.isRunning(id)` (throws if not running in this process);
  it does not special-case `awaiting_approval` as an explicit no-op — pausing during an
  approval wait arms the latch for the next checkpoint after the approval resolves, which
  is close in effect but not the literal no-op success described here.
- Steps already in flight are allowed to finish. Pause means "start no further step", not
  "abandon the current one" — an external write that has been issued must not be left in an
  unknown state. **As built:** the latch (`core/pauseGate.ts`) is checked cooperatively at
  step/turn boundaries via `waitWhilePaused`, matching this.
- The run reaches a new status, `paused`, which `isTerminal()` must report as **false**.
  **As built**, matching `packages/shared/src/domain.ts`.
- Emits a typed event so the dashboard can stop its own clock rather than guessing. **As
  built:** a `run.updated` event carries the `paused` status.

### `POST /runs/:id/resume`

**Partially implemented.** Plain resume (no body) works; the `revisions` payload and
everything it implies (re-authorization, versioned snapshots) is **still proposed, not
built** — the route reads no request body at all
(`apps/api/src/api/runs.routes.ts`, `services/runs.service.ts` `resumeRun()`).

Continues the run, optionally with an edited graph.

```
POST /runs/:id/resume
{
  "revisions": [
    { "nodeId": "n3", "changes": { "providerId": "...", "model": "...", "toolIds": [...] } }
  ]
}
```

- Succeeds only from `paused`. **Implemented** — `resumeRun()` returns an error when the
  gate reports the run was not paused.
- With no `revisions`, execution simply continues from the same snapshot. **Implemented.**
- With `revisions`, the run gets a **new snapshot version** — `graphSnapshot` is appended
  to, never overwritten. The trace must still be able to answer, for any completed step,
  which snapshot version produced it. **Not implemented** — no `revisions` handling exists.
- The response carries the new snapshot version so the dashboard can label the run
  truthfully as having been edited mid-flight. **Not implemented.**
- A revision naming a node that has already completed is rejected with `409`. Editing the
  past is exactly what the snapshot exists to prevent. **Not implemented** — there is
  nothing to reject yet.

### Recording

**Not implemented for this contract's revisions** — there is no resume-time node revision
to record yet. Note this rule IS already implemented for the adjacent, narrower case of a
pending tool *approval*: `apps/api/src/services/approvals.service.ts` `decideApproval()`
persists both `proposedAction` and `revisedAction` (plus `reauthorizedRule`) when a human
revises an approval payload. That is not the same thing as editing a `RUNNING` node's
config on resume, which this section describes.

The design spec already requires recording **both the proposed and the final action** for a
human approval. The same rule applies here: a revision records the original node and the
revised node, along with who or what produced it.

---

## Person 2 — authorization

**Not implemented as a resume-time gate.** No code constructs a `ToolAction` for a revised
node and re-authorizes it before leaving `paused`, because `resume` accepts no revisions to
authorize. The general principle described below — a revision may only narrow, never
widen, an action, and a deny/throw/timeout/missing-response all block — **is implemented**
for the separate case of a pending tool-approval revision: see
`apps/api/src/services/approvals.service.ts` (`decideApproval`, calling
`reauthorizeRevision` in `core/risk.ts`) and `apps/api/src/core/tools/approval.ts`. The
same discipline still needs to be applied here once resume-time revisions exist.

**Every revised node passes `authorize_action` before execution resumes.** A revision is a
revision whether a human typed it or the graph editor produced it, and the risk of an
action changes with its exact arguments and destination — which is precisely what a route
change alters.

Concretely:

- Resume constructs the exact `ToolAction` each revised node would now perform and calls
  `authorize_action` on it **before** the run leaves `paused`.
- A deny, a throw, a timeout or a missing response all block the resume. The run stays
  `paused` and the reason is reported. No default-allow, same as every other executor path.
- A revision may not downgrade the descriptor baseline. Changing a node's route from
  `local` to `cloud` can only ever make the applicable policy stricter, never looser — the
  strictest applicable result still wins.
- If the revision moves data across a privacy boundary — a `local_only` step re-routed to a
  cloud provider or to Browserbase — it is denied outright, per the safety invariants.

---

## Audit rule

**Not implemented** — there is no snapshot versioning today, since `resume` never produces
a new snapshot version. A run's trace must continue to answer **"what actually ran"**. That
means:

- Resume versions the snapshot; it does not mutate it.
- Every step records the snapshot version it executed under.
- The dashboard can therefore render a run that was edited mid-flight without ever implying
  that the edited node is what the earlier steps saw.

---

## What the dashboard does today, and what changes

**Half-landed.** Pause/resume is real; node editing is still disabled.

| Today                                                                                  | After this lands                                                             |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `canInterveneLive` is `false`; the inspector's edit control is disabled and states why | The flag is derived from the live capability and the control enables         |
| Preview runs the full edit loop against its own clock, labeled `preview`               | Unchanged — preview stays synthetic and labeled                              |
| Pause/resume is a working pair on a live run (**implemented**)                         | Unchanged                                                                    |
| A live run never falls back to preview behaviour                                       | Unchanged. This must stay true; `PRODUCT.md` forbids the fallback explicitly |

The UI contract is one constant, in `apps/web/src/lib/workspace.ts`, now half-flipped:

```ts
export const RUN_CAPABILITIES = {
  pauseResume: true, // POST /runs/:id/pause and /resume exist — IMPLEMENTED
  editRunningNode: false, // resume accepts revisions and re-authorizes them — still proposed
} as const;
```

`canInterveneLive` (`= pauseResume && editRunningNode`) is therefore still `false` today —
one flag flipping is not enough to enable the control.
