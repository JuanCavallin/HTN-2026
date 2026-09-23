# Sponsor prize tracks

Zephyr (codebase name: AgentOS) is a control plane for AI agents, built at Hack the North
2026. This page maps each prize track we submitted for to the feature that earned it and
the 60-second demo we showed that sponsor's judge.

## Result

**Top 12 for Warp — Best Developer Tool**, out of the full Hack the North field. Full
retrospective in [DEVPOST.md](DEVPOST.md).

Status legend: **Verified** = exercised against the real service from this repo.
**Built** = live adapter exists, needs a key. **Pitched** = no sponsor API; eligibility was
about what the product is.

## Tracks we submitted for

| Track                          | Result                           | What powers it                                                                                                                                                                                                        | 60-second demo for that judge                                                                                                                                                                                                                   |
| ------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Warp — Best Developer Tool** | **Top 12**                       | The whole product. It is infrastructure for developers who run agents: one OpenAI-compatible model gateway (`/v1`), one MCP tool gateway (`/mcp`), a replayable event stream, and a run-vs-baseline cost comparison.  | A run trace → Compare page (tokens, cost, latency vs the single-call baseline) → the 12 `pnpm check:*` invariant suites and CI. Then **Suggest an improvement**: the workflow critiques its own runs and proposes a forked, reviewable fix.                                                                                                            |
| **Browserbase**                | Verified                         | `apps/api/src/providers/browserbase/live.ts` (Stagehand v4). Eight browser tools (`browserbase.open/search/inspect/click/type/submit/extract/close`) behind the policy broker. Jev picks the target element by index. | Launched the **Demo run** playbook from `/runs`. Three swarm workers opened three Browserbase sessions in parallel. The egress ledger showed every call to `api.browserbase.com` with the data class it carried.                           |
| **Composio**                   | Verified (Gmail connected)       | `providers/composio/live.ts` + `register.ts`: catalog discovery, version pinning, per-user OAuth, `GMAIL_SEND_EMAIL` reviewed as an **irreversible** action.                                                          | Typed "Send an email to … saying …". Jev narrowed 1000+ Composio tools to a handful, the agent proposed the exact send, and the run **paused on the approval panel** showing recipient + body verbatim. Approve → it sends. Reject → it never leaves. |
| **GPTZero**                    | Built (needs `GPTZERO_API_KEY`)  | `providers/gptzero/live.ts` + `core/tools/contentCheck.ts`. Outbound text written in the user's name is scored before it is sent. The check is **escalate-only**: it can force a human approval, never waive one.     | Same email flow. The approval panel's reason: "outbound text scored P(AI)=0.9x ≥ 0.75". Point: agents sending AI slop under your name is the problem; this is the gate.                                                                    |
| **Rox — Best AI Agent**        | Pitched, not shortlisted         | Decisions under uncertainty are the core loop: calibrated Jev confidence, deterministic fallback below threshold, multi-source verification + adjudication, fail-closed tools, `blocked` → pause for a human.         | Demo run: three sources disagree, the adjudicate step flags two, the agent asks before filing. A `control.decided` card shows confidence + `source: jev / deterministic / fallback`.                                                   |
| **MLH — Best Use of Gemini**   | Built (needs `GEMINI_API_KEY`)   | `providers/gemini/` — a direct Google route in the model gateway, separate from OpenRouter, so route selection is a real decision between vendors and the ledger shows two distinct destinations.                     | A public task with `model.lifecycle` naming the Gemini model that actually served the call.                                                             |
| **Sentry**                     | Built (needs `SENTRY_DSN`)       | Tracing + logs over the step lifecycle and egress ledger. The prize requires two products beyond error monitoring.                                                                                                    | The Sentry trace for a run: one span per step, provider calls as children. See `docs/DEVPOST.md`, "Challenges", for the bug it found.                                                                                    |

**Honesty note.** Browserbase, Composio (Gmail connected), Jev, OpenRouter, Anthropic and local
Chrome were exercised against the real services from this repo. **GPTZero and Gemini were
implemented and covered offline** (`pnpm check:content-check`, `pnpm check:gemini`) against the
vendors' published API shapes but were not run with a live key during judging. Sentry stays inert
until `SENTRY_DSN` is set; with it you get **Tracing** (one span per outbound provider call,
created in the same proxy that writes the egress ledger) and **Logs** (one structured log per run
event) — shape only, never prompts or tool arguments.

## Tracks we considered but didn't submit for

| Track                         | Why it fits                                                                                                                                                                                                            | What is missing                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Zip**                       | Zip ships a remote MCP server; Zephyr's approval gate _is_ a procurement-approval story (thresholds, irreversible actions, human sign-off). Adding it is one call: `POST /api/mcp-connections {name, url, headerEnv}`. | A reviewed classification for Zip's tool names (unknown tools stay unavailable on purpose) and a Zip sandbox key. |
| **RBC — Signal in the Noise** | Verified: `http://3.143.20.160/mcp` connects through the generic MCP manager and its `financialdataretrieval` tool is discovered.                                                                                      | The tool is held `unavailable` until classified, and there is no retrieval/citation harness. Not claimable as is. |
| **Huawei openJiuwen**         | `ctx.fanOut()` runs parallel workers as child steps with a shared session.                                                                                                                                             | It is a swarm primitive, not agent-to-agent collaboration. Weak claim.                                            |
| **Cognition — Devin**         | Only if Devin genuinely built part of this (`.devin/` is in the repo).                                                                                                                                                 | A concrete, true story of what Devin did.                                                                         |
| **OpenAI**                    | OpenRouter's default allowlist routes to OpenAI models, but through OpenRouter, not the OpenAI API.                                                                                                                    | A direct OpenAI route + a true Codex story. Do not claim without both.                                            |

## Not claimed

QNX, Dryft, Dominion Dynamics, Expo, Bracket Bot, LeLamp, Tether, CSE, Thru, Solana, Shopify,
Intact, Federato, Linq, Elastic, Baseten, Backboard, Cloudflare, Snowflake, MongoDB, Tiger
Data, Vultr, ElevenLabs, Huawei OMNI, Aramco. Nothing in the repo used them.

## Not a prize track, but the heart of the demo

- **Jev (TypeSafe AI) via Vercel AI Gateway** — Verified. Every routing, tool-selection,
  browser-target and completion decision. It returns a choice and a calibrated confidence,
  never text. See [jev.md](jev.md).
- **Hermes (Nous Research)** — the first harness adapter, driven over ACP as a subprocess.
  Needs a local `hermes-agent` checkout + `uv`; see [provider-setup.md](provider-setup.md).
- **Anthropic** — Verified. The bound `text.model` for redacted summarisation.

## Demo-day checklist (kept for the next event)

1. `GET /api/providers` (or the provider badges in the UI) must show that sponsor's provider
   as `live` **and** healthy. `live` + unhealthy is not ready; `mock` is not a claim.
2. Have one completed run open in a tab in case the network dies. Stored runs replay from
   SQLite with no network.
3. Never describe a mock as live. The UI labels modes truthfully; keep the pitch the same.
