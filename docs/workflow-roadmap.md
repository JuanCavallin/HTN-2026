# Workflow execution and supervision roadmap

Updated: 2026-09-22. Active follow-up to the archived graph workflow plan.
The [design specification](agentos-design.md) remains authoritative for privacy,
permissions, exact-action approval, and the harness-agnostic architecture.

## Agreed execution rules

1. **Known recipe:** use direct `tool` nodes. Arguments can be literal values or
   references to upstream results; runtime data does not require runtime tool choice.
2. **One bounded tool choice:** use `dispatch`. Jev chooses among real candidates;
   an optional generative call supplies arguments. No agent loop.
3. **One generative transformation:** use `decide` (the existing name for a
   `text.model` call), not a Hermes task.
4. **Adaptive observe/reason/act loop:** use a bounded `agent_task`, even when all
   tools are known or only one tool is repeatedly needed. Specify the objective,
   completion criteria, relevant candidates, duration, and failed-call budget.
5. **No real runtime uncertainty:** accept a graph without `dispatch` or
   `agent_task`. Delegation counts are descriptive, not a validity or quality score.

Keep fixed steps around adaptive subtasks. A failed direct call does not implicitly
escalate to Hermes. Any fallback must be represented explicitly and reauthorized.
Tool eligibility/selection is not permission: every exact action still passes the
AgentOS gate. Native Hermes tools must not bypass the model/MCP gateway and broker.

## First batch: planning and admission (P0)

Status: implemented; automated verification passed below. Live-provider/UI acceptance
remains a manual check, not a claimed result of the offline tests.

Scope: graph synthesis and its tests. No execution, permission, browser, or UI
redesign in this batch. The existing node schema and service API remain compatible.

- Replace the forced-delegation prompt with the five rules above.
- Allow known-tool adaptive research through registered, brokered tools; distinguish
  it from a fixed lookup and from interactive browser state.
- Preserve browser session-reference guidance and irreversible-action boundaries.
- Stop rejecting a valid graph solely because it has no runtime delegation.
  Continue rejecting malformed graphs and empty synthesized workflows.
- Keep delegation field names for existing clients, but document their descriptive
  meaning and avoid calling direct execution zero-cost or model-free.
- Isolate the synthesis engine from production wiring so deterministic test doubles
  exercise the actual validation/repair loop without network or database access.
- Include regression tests in `pnpm check:graph`, which already runs in CI.

Acceptance checks (tick only after the commands pass):

- [x] `pnpm --filter @htn/api check:graph-synthesis` (16 checks): direct-only and upstream-ref
      graphs accepted on attempt one; one-shot model, dispatch, and known-tool agent
      shapes remain accepted; chat can remove the last agent task; invalid structures
      and empty plans still repair or fail; prompt safety/session guidance retained.
- [x] `pnpm typecheck`.
- [x] `pnpm test` (includes model gateway, MCP gateway, broker and browser checks;
      all 32 web tests passed).
- [x] `pnpm build` (successful; bundle-size warning remains).
- [x] Isolated mock HTTP check (in-memory store, ephemeral localhost server):
      create a direct-only graph, seed a conversation, use the deterministic mock
      `OPTIMIZE:` edit, and verify HTTP 200, unchanged graph identity/positions,
      no inserted dispatch/agent task, and no launched runs. No live provider called.

These tests establish deterministic admission behavior and prompt content. They do
not prove that a live model chooses the intended node type for every natural-language
request, or that a live Hermes/browser integration completes successfully.

## Next: execution context and resource ownership (P0)

Owners: Person 1 (runtime/session lifecycle), Person 2 (context/privacy/policy),
3A (tool gateway), 3B (browser). Agree additive contracts before changing these tracks.

1. **Separate three identities:** workflow run, agent context scope, and resource
   reference. Keep node type as the single source of execution strategy; do not add
   a conflicting second execution-mode field. Define explicit artifact inputs and
   outputs instead of handing each agent every completed node's context.
2. **Bind gateway requests to the actual session/turn.** Replace the global
   single-active-Hermes lookup with trusted scoped routing for both model and MCP
   requests. A model-supplied scope ID must not authorize another session's tools.
   Continue failing closed on missing, stale, or ambiguous bindings.
3. **Make graph capabilities an enforced boundary.** Current `availableTools` is a
   candidate list, not a hard cap: discovery adds candidates. Define an optional
   explicit capability ceiling, distinguish omitted from empty, intersect discovery
   and Jev selection with it, and recheck it at execution. Retain exact-action checks.
4. **Add explicit fresh/continue agent context semantics.** Reuse a harness session
   across sequential nodes only when they name the same approved scope. Track scope
   version, provenance and labels; publish explicit context/artifact updates from
   intervening direct calls. Do not equate reusing a browser with reusing a transcript.
5. **Move shared resource lifetime to the run/scope owner.** Do not close a browser
   after an individual agent node if a later graph step still needs it. Release on
   terminal run/cancellation, with explicit expiration/recovery behavior.
6. **Enforce one writer per mutable resource/context.** Serialize actions sharing a
   browser page or mutable transcript, including human takeover. Independent agents
   get fresh scopes and resources; merge their labeled artifacts at a join. Only
   enable parallel Hermes tasks after trusted scoped routing is tested.
7. **Return useful, privacy-safe tool results.** The MCP path currently exposes a
   compact summary. Add typed sanitized results/artifact references where needed
   for an agent to act on search evidence; keep full documents and secrets out of SSE.

Acceptance: repeated calls in one scope continue; isolated scopes cannot read or
mutate each other; expired scope/resource references fail explicitly; parallel
independent tasks are correctly attributed; shared resources cannot have two writers;
unknown/unselected tools, local-only egress and unapproved external writes stay blocked.

## Browser continuity and research split (P0, after resource contracts)

Owners: 3B with Person 1; Person 2 reviews privacy and side-effect handling.

1. Inventory registry tools as research search/extract versus interactive browser
   operations using trusted metadata. Both direct and Hermes calls use the same
   brokered implementations. Do not expose native harness search as an escape hatch.
2. Research usually needs evidence/artifacts, not a persistent visible page. Fixed
   queries run directly; adaptive investigation uses Hermes with the same known tools.
3. Interactive nodes reference the existing browser session **and page**, retaining
   login, navigation, cookies, and user changes. Reattach to the selected page rather
   than creating a new page. Parallel browser work uses explicitly separate resources.
4. Fail on missing/unresolved/stale required session refs instead of silently opening
   a fresh blank session. Preserve existing `{{open.result.sessionId}}` graphs through
   a compatibility mapping. Credentials remain human-entered, not graph arguments.
5. Implement server-enforced agent/view-only/human ownership. On takeover, stop new
   agent actions and settle in-flight work; on resume, refresh page observations and
   invalidate stale element handles. Human completion is not an approval for unrelated
   side effects. Recheck exact actions after resuming.

Acceptance: open -> user login -> resume -> another node keeps the same session/page;
expired sessions produce recovery UI, not a hidden restart; two graph nodes cannot
race on the same page; cancellation releases sessions without discarding another
active owner's resource.

## Live supervision pane (P1, depends on browser/context contracts)

Owners: Person 4 with Person 1 and 3B. Keep the overall graph rendering redesign later.

1. Correlate real-time tool/model lifecycle events to run, node, scope, call and
   resource IDs. Show a Hermes node's expandable inner trace while retaining its
   logical graph identity. Preserve truthful live/mock/fixture/replay labels.
2. For research, show searches, tool status, evidence metadata/citations and artifacts;
   do not invent a browser view for a tool that has no visible page.
3. For interactive browsing, obtain the existing session/page live-view URL from an
   authorized API endpoint and embed it in the side pane. Preserve viewer identity
   by resource, not by trace update; handle expiry/disconnection without reopening
   the task's browser. Verify current provider embedding requirements at implementation.
4. Add view-only and explicit takeover/resume controls backed by server ownership,
   with an external-view fallback where embedding is unavailable. Hiding pointer
   events alone is not an authorization mechanism.
5. Show agent scopes and shared browser resources as separate badges/lanes. A fresh
   agent can use an existing browser; continuing an agent need not imply a browser.

Acceptance: live activity appears before task completion, updates do not reload the
viewer, human takeover blocks agent mutation, and disconnected/unsupported views are
honestly explained.

## Run comparisons and persistence (P1, can proceed independently)

Owners: Person 4 (display/metrics), Person 1 (storage), Person 2 (baseline evaluation).

1. Trace both compare selections through API responses, stored runs/steps/egress,
   aggregation, and frontend refresh. Distinguish missing data, no selected run,
   in-progress, error, and genuine zero measurements.
2. Persist comparison identity: graph/version, equivalent input or privacy-safe input
   fingerprint, baseline/previous-run IDs, execution mode, configuration and success
   criteria. Add a migration only for fields confirmed missing; do not create a second
   inconsistent metrics store.
3. Recompute from measured events with consistent token, latency and cost units.
   Refresh the compare list and selected results as runs complete; preserve explicit
   pairing rather than comparing arbitrary latest runs.
4. Align the baseline to the same task/input and assertions, not a static unrelated
   demo. Count savings only when both satisfy the required checks. Label incomparable,
   failed and mock/live-mixed results rather than displaying misleading savings.

Acceptance: a run and its baseline populate both columns; comparing a prior run also
works; reload/restart preserves the pair; missing metrics are not rendered as zero;
zero-delegation workflows are measured normally, without a delegation penalty.

## Unified graph presentation (P2, deliberately last)

Owner: Person 4. Share graph identity, layout and node styles between authoring and
execution; overlay status, measurements, scope/resource markers and expandable tool
traces. Do not replace logical nodes with unrelated runtime nodes or infer dependencies
from event arrival order. Preserve selection and layout across updates.

## Manual checks for the first batch

Start with `pnpm dev` and **Build a workflow** (not **Run as agent task**, which
intentionally always uses Hermes). Drafting never starts execution. Use synthetic
public inputs. Live synthesis needs a working configured text-model provider; mock
responses are fixtures and are not a test of natural-language routing quality.

1. Ask: "Summarize these supplied notes in three bullets. Notes: launch Tuesday;
   owner Alex; follow-up Friday. Do not research the web." Expect a one-shot `decide`
   step (optional input/redaction plumbing), with no forced dispatch or Hermes task.
2. With a reviewed web read tool connected, ask: "Read https://example.com once and
   summarize that page. No other research." Expect a direct tool plus a summary, not
   an invented provider choice. Check the API log accepts it without a fully-pinned
   rejection or an unnecessary repair call.
3. Ask for two known reads, with the second URL taken from the first result. Inspect
   the upstream reference and ordering; a reference alone should not create dispatch.
4. Ask: "Research this public claim, follow conflicting evidence, and stop after
   corroborating it or reporting uncertainty. Use the connected search/read tools;
   limit the task to two minutes and two failed tool calls." Expect a bounded
   `agent_task` with catalog tool names despite their being known. Do not expect this
   batch to add a new research provider or a shared browser/context feature.
5. Edit that plan: "Replace the investigation with one read of https://example.com
   and a summary. Remove the agent task." Expect the remaining workflow to save
   without adding a replacement dispatch/task. Existing node positions should persist.
6. In mock mode, run a direct-only graph and check that its execution contains no
   fabricated Hermes task. For any live run, first review provider modes and the plan;
   verify actual tool calls appear in the authorized trace. Do not test outbound sends
   or purchases merely to check routing.
7. Use the offline regression command for invalid JSON, empty plans, duplicates,
   dangling edges and cycles; natural-language prompts are not a reliable way to
   force a model to generate a particular invalid structure.

Still pending after this batch: shared context/resources, browser continuation and
the live side pane, comparison fixes, and the unified graph view. No migration is
needed for the planning/admission changes.
