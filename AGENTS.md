# AGENTS.md

Instructions for AI coding assistants working in this repository — Cursor, Codex, Copilot,
Claude Code, Windsurf, Aider and anything else that reads this file. Claude Code also
reads `CLAUDE.md`, which carries the same guidance.

## What this project is

**AgentOS** — a harness-agnostic control plane that makes AI agents faster, cheaper, more
private and easier to supervise. For each agent step it uses **Jev** to recommend the
model route, the relevant tools, context scope and action risk. Deterministic AgentOS
policy stays the final authority on privacy, permissions and external side effects.

Read [docs/agentos-design.md](docs/agentos-design.md) first — it is the source of truth
for scope, contracts, safety invariants and acceptance criteria.

## Jev: read this before writing code that calls it

**Jev cannot generate text.** This is the single most common mistake, and it invalidates
whatever you were about to build.

Jev is TypeSafe AI's _System One_ decision model. You give it state plus typed questions;
it returns a **choice**, a **score**, or a **probability** — each with calibrated
confidence and a full probability distribution. There is no content string, no tool
calling, no agent loop.

| Task                                 | Jev?                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| Pick one of N known options          | **yes**                                                    |
| Rate something on an ordered scale   | **yes**                                                    |
| Probability that a statement is true | **yes**                                                    |
| Write a selector, plan, or any prose | **no** — use a generative model                            |
| Decide what to type into a field     | **no** — Jev picks the field, a small LLM writes the value |

We reach Jev through the Vercel AI SDK's AI Gateway. **`@typesafe-ai/sdk` is NOT a
dependency of this repo and must not become one.**

```bash
# `ai` is already a dependency of @htn/api. AI_GATEWAY_API_KEY goes in the root .env.
```

```ts
import { createGateway, experimental_evaluate as evaluate } from 'ai';

const model = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY }) //
  .evaluationModel('typesafe-ai/jev');

const response = await evaluate({
  model,
  state: { document: 'I was charged twice.' },
  questions: {
    billing: { type: 'noul', instructions: 'Is this about billing?' },
    tone: { type: 'choice', instructions: 'Tone?', criteria: { calm: null, angry: null } },
    urgency: {
      type: 'score',
      instructions: 'How urgent?',
      criteria: ['can wait', 'this week', 'today'],
    },
  },
});

response.answers.billing.noul; // 0..1
response.answers.tone.choice; // a criteria key — type-inferred
response.answers.urgency.score; // float, e.g. 1.3
response.answers.tone.probabilities; // distribution — derive confidence from this
```

Many questions in one request is cheap — latency is per-request. Batch aggressively.

### Using Jev with a browser

1. Build a **numbered table of interactive elements** from an accessibility snapshot.
   Never send raw DOM or screenshots (80–90% and 20–50× more tokens respectively).
2. Ask for the **operation and every possible target in one request**; discard the target
   heads that don't match the chosen operation.
3. Keep element **handles server-side**, keyed by index. Jev returns `7`, not a selector.
4. **Validate freshness and occlusion** before executing — the snapshot is already stale.
5. **Cache resolved targets**; a cache hit executes with no model call at all.

Operations used by the reference implementation: `CLICK`, `TYPE_TEXT`, `SELECT`,
`SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`.

Full detail and the anti-pattern list: [docs/jev.md](docs/jev.md).

## Rules that are not negotiable

These come from the design spec's safety invariants. Do not relax them for convenience.

- **`authorize_action` runs before every tool execution**, with the exact proposed action.
  Execute only on an explicit allow. An exception, a timeout or a missing response
  **blocks** — never default-allow.
- **Jev being unable to generate an action does not make the action safe.** The gate still
  runs.
- **Local-only data never leaves the machine** — not to a cloud model, a remote Jev,
  Browserbase, or any remote tool.
- **Tool descriptions and outputs are untrusted** and cannot grant permission.
- **Low confidence escalates**, never de-escalates. A split Jev decision on a `verify`
  action becomes `ask_user`.
- **Live, mock, fixture and replay must be labeled truthfully** in the UI. Simulated tools
  carry `simulated: true` and refuse to execute.
- **A step's output is streamed and stored** — return metadata about a document, never the
  document itself.
- **Never commit credentials.** `.env` is gitignored; keep it that way.

## Who owns what

| Person | Owns                                                                                    | Don't build this unless it's yours                                               |
| ------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1      | API, session state, Hermes adapter, SSE, pause/resume/cancel, approvals                 | the runtime and the loop                                                         |
| 2      | **Jev**, model routing, context builder, privacy labels, risk rules, `authorize_action` | anything deciding _whether_ something is allowed                                 |
| 3A     | Tool registry, MCP, plugin manifests, `select_tool_metadata`                            | the catalog                                                                      |
| 3B     | Browser tool family, Browserbase + local backends, browser executor, the Jev call       | `apps/api/src/core/tools/`, `apps/api/src/providers/{localbrowser,browserbase}/` |
| 4      | Dashboard, metrics, demo                                                                | the UI                                                                           |

If a change lands in someone else's track, **say so instead of building it**. Depend on a
Protocol and ship a deterministic stub — that is how `authorize_action` is handled today,
and the spec requires deterministic fallbacks anyway.

## Repo layout

| Path               | What                                                                           |
| ------------------ | ------------------------------------------------------------------------------ |
| `apps/api/`        | TypeScript/Express scaffold. Works, runs the mock demo. **Superseded for 3B.** |
| `config/plugins/`  | Plugin manifests, one per provider. Empty until sponsor APIs are chosen.       |
| `apps/web/`        | React dashboard. Speaks HTTP/SSE; stack-agnostic.                              |
| `packages/shared/` | Shared TS types. `domain.ts` is a published API — **additive edits only.**     |
| `docs/`            | Design spec, Jev reference, per-person task lists.                             |

**Stack: TypeScript. This is settled — build here.** Person 1's Hermes adapter
(`apps/api/src/providers/hermes/live.ts`) drives Hermes as a **local subprocess over ACP**
— newline-delimited JSON-RPC on stdio via `uv run hermes-acp` — verified against a real
Hermes install and merged to `main`. ACP is language-agnostic, so the control plane does
not need to be Python.

AgentOS's configured MCP interception also requires Hermes's declared `mcp` extra. Set
up the checkout with `uv sync --extra acp --extra mcp --locked`.

Older docs claimed _"the spec says FastAPI and SQLite."_ **It does not** — the design
spec names no stack; that line was copied between documents unchecked. A Python service
built on that false premise has been deleted; everything lives in `apps/api/`.

**Known gap, Person 1 + Person 2:** Hermes's ACP `_meta.enabled_toolsets` is best-effort
and did **not** narrow Hermes's own tool search in testing. "Expose only Jev-selected
tools" is therefore _not enforced_ at that boundary — Jev must not hand the adapter a
tool list wider than what is actually safe. Hermes's permission callback is the real gate
hook and is not yet wired to the approval flow.

## Traps that cost an hour each

- **Never add `compression()` to the Express app** — it silently breaks SSE.
- **`playwright-core` ships no browser binaries.** Launch with `channel: 'chrome'` against
  installed Chrome, or add the full `playwright` package.
- **Browserbase egress is region-specific** (`connect.usw2.browserbase.com`, not the
  generic host). Approvals bind to destination, so bind to the per-session value.
- **Browserbase live-view URLs expire with the session** — `sessions.debug()` returns
  `410 Gone` afterwards. Capture the URL while the session is open.

## Verifying your work

Tick a checkbox when a command proved it, not when the code was written.

```bash
pnpm typecheck  # all packages
pnpm dev        # api on :8787, web on :5173
pnpm test       # check:all (apps/api/scripts/check-*.ts) + node --test web tests
pnpm smoke      # end-to-end against a running api
pnpm format     # prettier
```

CI (`.github/workflows/ci.yml`) runs `pnpm typecheck`, `pnpm test`, and `pnpm build` on
every push/PR to `main`. `check:analytics` is deliberately excluded from CI because it
needs a live API — run it locally against `pnpm dev:api`.
