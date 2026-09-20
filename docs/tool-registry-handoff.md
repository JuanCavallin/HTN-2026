# Tool registry handoff — Person 3 (3A, registry + MCP)

`implementation_plan.md` M1 assigns you: _"Build tool registry with 50+ real/simulated tools;
implement common tool interface and read/write classification."_

The graph interpreter now depends on the second half of that sentence, and is currently
standing in for it with a hardcoded table. This document is the contract it needs and, more
importantly, **the full list of places that have to agree** — the registry touches more of the
codebase than it looks like from the outside.

Nothing here blocks you from starting. Everything works today with the stopgap; the stopgap is
just noisy and wrong for any tool nobody thought of.

---

## 1. Why the graph needs this

`core/risk.ts` decides whether a human gets asked, and it classifies a `ProposedAction` by its
`kind` (`send_email`, `submit_form`, `read_page`, …). A hand-written playbook passes that kind
literally — `demo.playbook.ts` says `kind: 'submit_form'` in the source.

A graph cannot. A `tool` node names a tool, and a **`dispatch` node does not know which tool it
will call until a model has picked one.** So the tool name has to map to an action kind, and the
mapping has to live with the tool.

Getting this wrong in the permissive direction is the worst bug available in this codebase: it
would let a model-selected `mail.send` run unattended, which turns `dispatch` into a way around
the approval gate.

**Today's stopgap:** `apps/api/src/core/graph/toolRisk.ts` holds a 12-entry table and treats any
unlisted tool as irreversible, so unknown tools stop for a human. That fails closed, which is
correct, but it means every tool you add that isn't classified will block a run until someone
clicks approve.

---

## 2. The contract

One field on the catalog entry. That is the whole ask.

```ts
// packages/shared/src/providers.ts  —  ToolboxAdapter.listTools
export interface ToolCatalogEntry {
  name: string; // exists today
  description: string; // exists today

  /** NEW. What calling this does, in core/risk.ts's vocabulary. */
  actionKind: string; // 'read_page' | 'send_email' | 'submit_form' | ...

  /** NEW, optional. Overrides the kind→reversibility inference when you know better. */
  reversibility?: 'reversible' | 'recoverable' | 'irreversible';

  /** Optional, useful for the editor's tool picker. */
  group?: string; // 'browser' | 'mail' | 'sheets' | ...
}
```

Two rules:

- **`actionKind` must be a string `core/risk.ts` already recognises**, or the classification
  silently falls through to `reversible` and the tool runs unattended. If you need a kind that
  isn't there, add it to `IRREVERSIBLE_KINDS` / `RECOVERABLE_KINDS` in the same PR — see §3.5.
- **Tool names are OUR vocabulary, not a vendor's.** `domain.action`, lowercase, dot separated:
  `browser.extract`, `mail.send`, `sheets.append`. Whatever Composio or an MCP server calls it,
  translate at the adapter boundary. This is the same rule `providers.ts` states at the top of
  the file, and it is what lets a tool move between providers without touching a graph.

---

## 3. Everywhere that has to match

Work down this list; the middle entries are the ones that get missed.

### 3.1 `packages/shared/src/providers.ts` — the type

`ToolboxAdapter.listTools` currently returns `{ name, description }[]` inline. Promote it to a
named `ToolCatalogEntry` and add the fields above. Additive and optional-where-possible, per the
file's own editing rule.

### 3.2 `apps/api/src/providers/composio/index.ts` — the mock

The `TOOLS` array has **4 entries**. This is the one that becomes 50+. It must stay
**deterministic** — a rehearsed demo has to show the same catalog every time — and it is what
every mock-mode demo and the smoke test actually reads.

### 3.3 `apps/api/src/providers/composio/live.ts` — the live adapter

Must return the _same shape_ as the mock, with names already translated into our vocabulary. If
live and mock disagree on names, graphs authored against mocks break the moment
`COMPOSIO_MODE=live` — exactly the failure the mock/live split exists to prevent.

### 3.4 `apps/api/src/core/graph/toolRisk.ts` — **delete this file's table**

Replace `toolRisk()` with a registry lookup. Keep the fail-closed behaviour for a tool that is
genuinely absent from the catalog; keep `explicit` (a node's own `actionKind`) winning, since a
graph author who names the kind knows more than the catalog does.

### 3.5 `apps/api/src/core/risk.ts` — the kind vocabulary

`IRREVERSIBLE_KINDS` and `RECOVERABLE_KINDS` are the allowed values of `actionKind`. Anything
not in either set is inferred `reversible` and runs unattended. **Every new kind your registry
emits must be added here in the same change**, or it silently becomes auto-approved.

### 3.6 `apps/api/src/api/tools.routes.ts` — the endpoint

Serves the catalog to the editor's tool picker. Has a 60s cache; if you add a "reload registry"
path, invalidate it. The synthetic `runId: 'sys_catalog'` is deliberate — it keeps the catalog
read in the egress ledger rather than bypassing it.

### 3.7 `apps/web/src/lib/api.ts` — the client type

`api.tools()` declares the response shape inline. It has to gain the same fields or the editor
cannot colour a tool by risk.

### 3.8 `apps/api/src/core/graph/demo.graph.ts` — the seeded graph

Its `candidateTools` (on `notify`) and `availableTools` (on `followup`) name tools that must
exist in your registry: `sheets.append`, `calendar.create`, `mail.send`, `browser.navigate`,
`browser.extract`, `web.search`, `docs.read`, `docs.draft`, `forms.submit`. Keep these names or
update the graph in the same change — a seeded graph that references missing tools is the first
thing anyone sees on the canvas.

### 3.9 `apps/api/src/core/playbooks/demo.playbook.ts` — a hardcoded array to delete

`CANDIDATE_TOOLS` (~line 99) is a stand-in for your registry and says so in its comment. Once
the registry exists, this reads from it. **Do not change this file before the registry lands** —
it is the fallback run that works when graph execution doesn't.

### 3.10 `apps/api/src/providers/hermes/live.ts` — harness translation

The harness gets tool names via `_meta.enabled_toolsets`. `AgentTaskSpec`'s doc is explicit that
the candidate list is _not_ tied to any one runtime's naming and that the harness adapter does
the translating. If Hermes needs its own names, map them there, not in the registry.

Also read that file's header before you assume tool restriction works: **Hermes does not enforce
the exposed set** (`enabled_toolsets` is best-effort and did not change its `tool_search` count
in testing). That is why irreversible tools must never enter an `availableTools` list in the
first place.

### 3.11 Tests that assert the current catalog

- `scripts/smoke.mjs` asserts **`4 tools`** and that every entry has a name and description.
- `apps/api/scripts/graph-schema.check.ts` uses `sheets.append` in its fixtures.

Both will fail the moment the catalog grows. That is intended — they are the tripwire that says
"the contract changed, check the list above."

---

## 4. Checklist

- [ ] `ToolCatalogEntry` with `actionKind` in `packages/shared/src/providers.ts`
- [ ] Composio mock grown to 50+ deterministic, classified tools
- [ ] Composio live adapter returns the same shape and the same names
- [ ] Any new `actionKind` values added to `core/risk.ts`
- [ ] `core/graph/toolRisk.ts` reads the registry; hardcoded table deleted
- [ ] `apps/web/src/lib/api.ts` response type updated
- [ ] `demo.graph.ts` tool names still resolve
- [ ] `smoke.mjs` tool-count assertion updated
- [ ] `pnpm check:graph` and `pnpm smoke` green

## 5. Two things to decide with the team

**Does `actionKind` belong to the tool or the call?** `mail.send` to an internal address may be
reversible; to a customer it is not. Today the tool carries one kind and a node can override it.
If that turns out to be too coarse, the override is the escape hatch — don't make the registry
model it.

**Who owns MCP tool names?** An MCP server supplies its own. Translating them into our vocabulary
at the adapter keeps graphs portable; passing them through unchanged is less work but means a
graph is pinned to one server's naming. The rest of the codebase assumes the former.
