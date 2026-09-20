# Jev — what it is and how to use it

**Read this before writing any code that calls Jev.** Jev is not a chat model and does
not behave like one. The most common mistake is asking it to generate something.

> **Status of this document.** Everything here was verified against TypeSafe's published
> docs and the `browser-use/jev-ultrafast` source. **No live Jev call has been made from
> this repo** — we have no `TYPESAFE_API_KEY` yet. Treat request/response shapes as
> documented-but-untested, and fix this file the first time reality disagrees with it.
> time reality disagrees with it.


---

## The one thing to know

**Jev returns typed, calibrated answers. It cannot generate free text.**

It is TypeSafe AI's *System One* decision model. You give it state and a set of typed
questions; it returns a choice, a score, or a probability — each with confidence and a
full probability distribution. There is no `content` string. There is no tool calling.
There is no loop.

So:

| You want | Jev? |
| --- | --- |
| "Which of these 12 buttons is the login button?" | **yes** — this is exactly what it's for |
| "Is this ticket about billing?" | **yes** |
| "How urgent is this, 0–2?" | **yes** |
| "Write a CSS selector for the login button" | **no** — it cannot generate |
| "Plan the next five steps of this task" | **no** — use a generative model |
| "Fill in this form field with the user's email" | **no** — Jev picks the *field*; a small LLM supplies the *text* |

If you catch yourself designing a prompt, stop. Jev takes `criteria`, not prompts.

---

## Setup

This repo is TypeScript. Use the JS/TS SDK.

```bash
npm install @typesafe-ai/sdk          # requires Node 20+
# TYPESAFE_API_KEY goes in the root .env
```

| | |
| --- | --- |
| Package | `@typesafe-ai/sdk` (npm; 0.6.0 at time of writing) |
| Client | `new TypeSafeClient()` → `client.systemOne({ state, questions })` |
| Auth | `TYPESAFE_API_KEY` environment variable |
| Model id | `jev-latest` |
| Raw endpoint | `POST https://api.typesafe.ai/v1/systemone` |

A Python SDK (`typesafe-sdk` on PyPI, with `AsyncTypeSafeClient`) exists too, if an MCP
server or side tool ever needs it. The SDK is a thin wrapper over that endpoint;
`jev-ultrafast` posts raw JSON only because it predates the SDK.

---

## The three primitives

All three can go in **one request**, and every answer carries calibrated probabilities.

```ts
import { choice, noul, score, TypeSafeClient } from '@typesafe-ai/sdk';

const client = new TypeSafeClient();
const response = await client.systemOne({
  state: { document: 'I was charged twice. Please fix this ASAP.' },
  questions: {
    billing: noul('Is this ticket about billing?'),
    tone: choice("What is the customer's tone?", {
      calm: null,
      frustrated: null,
      angry: null,
    }),
    urgency: score('How urgent is this ticket?', ['can wait', 'this week', 'today']),
  },
});

response.answers.billing.noul; // 0..1
response.answers.tone.choice; // one of the criteria keys — type-inferred
response.answers.urgency.score; // float, e.g. 1.3 — interpolated, not an index
response.answers.tone.confidence; // calibrated
response.answers.tone.probabilities;
```

The answer type is **inferred from the questions object**, so a typo in a criteria key is
a compile error rather than a runtime surprise.

- **`choice`** — pick one key from a `criteria` object. Values may be `null` when the key
  speaks for itself, or a description string when it doesn't.
- **`score`** — rate against an **ordered** criteria list. Returns a float between the
  endpoints (`1.3` means "between level 1 and 2, nearer 1"), plus a `legend`.
- **`noul`** — probability that a proposition holds. Returns `0..1`, not a boolean.

### Why "many questions, one request" matters

Latency is per-request, not per-question. Batching is close to free, which is what makes
the browser pattern below work.

---

## Using Jev to drive a browser

This is the pattern `browser-use/jev-ultrafast` (8k+ stars, MIT) converged on, and it's
the one this repo follows.

### 1. Turn the page into an indexed element table

Never hand Jev raw DOM or a screenshot. Build a numbered table of *interactive elements
only*:

```text
[1] button    Change ticket type · Round trip
[2] combobox  Where from?        · San Francisco
[3] combobox  Where to?          · empty
[4] textbox   Departure          · empty
```

The integer index becomes the `criteria` key. Keep the live element handle server-side,
keyed by that index — **do not** convert to a CSS selector and hand it back out. Selectors
go stale; handles don't, and Jev only ever needs to say "7".

An accessibility-tree snapshot is the cheap way to build this. On `example.com`,
Playwright's `locator.aria_snapshot()` describes the whole page in 186 characters. A
screenshot of the same page is ~100KB, and vision tokens cost 3–5× text tokens.

### 2. Ask for the operation and every possible target at once

```text
                      one TypeSafe request
                     ┌───────────────────────────┐
page → element table → operation                 │
                     │ click_target              │
                     │ type_text_target          │
                     │ select_target, if present │
                     └─────────────┬─────────────┘
                         use the matching target
                                   │
                    CLICK [7] ─────┤──→ browser
                TYPE_TEXT [3] ─────┘
                          ↓
                   small LLM → text → browser
```

Target questions are **speculative**: you ask for a click target *and* a type target,
then discard whichever doesn't match the chosen operation. Two decisions, one round trip.

**This trade is deliberate and it is not free.** The published benchmark measured tasks
31–43% faster but inference cost 38–51% *higher*, because you pay for discarded target
heads. Tune the number of speculative heads if cost matters more than latency for a given
run. (That benchmark was four runs with no outcome verification, self-disclaimed by its
authors — treat the direction as real and the magnitudes as noise.)

### 3. The operation vocabulary

`jev-ultrafast` uses: `CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`,
`DONE`, `BLOCKED`.

Note `DONE` / `BLOCKED` — the same vocabulary as this project's completion judge.

`TYPE_TEXT` is the one that needs help: Jev picks *which field*, and a small generative
model supplies *what to type*. Its own label says so — *"A small LLM will supply the value
from the goal."*

### 4. Validate before you execute

Jev chose an index from a snapshot taken a moment ago. Before acting, check:

- **Freshness** — is the document still the one we snapshotted?
- **Occlusion** — is the target actually clickable, or is a modal covering it?

This is where browser agents get flaky. `jev-ultrafast` guards both.

### 5. Cache the resolved target

Once an intent resolves to an element on a given page, cache it. On a hit, execute with
**no model call at all**; re-invoke Jev only on a miss, then rewrite the entry. Stagehand
calls this self-healing.

For a live demo this matters more than it sounds: after one warm-up run your demo path is
deterministic, fast and free, with no model nondeterminism on stage.

---

## How Jev fits AgentOS specifically

Two places where Jev's actual behaviour lines up with
[agentos-design.md](./agentos-design.md):

**1. Confidence gating is implementable, not aspirational.** The spec says AgentOS accepts
`done` only when *"Jev clears the configured confidence threshold."* Jev returns real
calibrated probabilities, so that threshold is a number you can actually compare against.

Use it for risk too: if Jev is split 0.5/0.5 between two buttons on a `verify` action,
**escalate the action to `ask_user`**. Low confidence should raise the risk class, never
lower it. That's "deterministic policy overrides Jev" made concrete.

**2. Jev is structurally quarantined.** The recommended defence against prompt injection
from web pages is the dual-LLM split: a privileged planner with tools, and a quarantined
reader that sees untrusted content but has no tool access. Jev *is* the quarantined
reader by construction — a model that can only return an index into a list you built
cannot be talked into issuing an action, no matter what the page says.

This does **not** remove the need for the gate. Page content can still steer *which*
element gets picked, so `authorize_action` still runs before every execution, and
consequential operations still need approval.

### Ownership

**Person 2 owns Jev** — the scheduler, the completion judge, routing and thresholds. If
you are not Person 2 and you need a Jev decision, depend on a Protocol and ship a
deterministic stub behind it, the way `authorize_action` is handled. The spec requires a
deterministic fallback anyway, so the stub is not throwaway work.

---

## Anti-patterns

- **Asking Jev to generate.** No selectors, no code, no prose, no plans. It returns a
  choice from your list.
- **Treating Jev as an agent.** It has no loop, no memory and no tools. "Spawn a Jev
  agent" is not a thing. The loop belongs to the caller.
- **Handing it raw DOM or screenshots.** Build the indexed table. 80–90% fewer tokens.
- **Handing back selectors instead of indices.** Keep handles server-side.
- **Acting on a stale snapshot.** Check freshness and occlusion first.
- **Trusting confidence blindly.** Low confidence is a signal to escalate to a human, not
  to retry harder.
- **Skipping the gate because "Jev is safe."** Jev being unable to *generate* an action
  does not mean the action it *picked* is authorized.

---

## Sources

Docs and source read while writing this:

- TypeSafe AI docs — <https://docs.typesafe.ai/> (primitives, quickstart, Python SDK)
- `browser-use/jev-ultrafast` — <https://github.com/browser-use/jev-ultrafast>
  (MIT; `model.py` for the `choose()` call, `snapshot.js` for the element table)
- Jev browser-agent benchmark — <https://rtrvr.ai/blog/jev-browser-agent-benchmark>
  (2026-09-16; n=4, self-disclaimed methodology)
- `jev-browser` skill listing — <https://aiskill.market/skills/jev-browser-jkudish>
- Playwright MCP snapshots — <https://playwright.dev/mcp/snapshots>
- Stagehand caching / self-healing — <https://docs.stagehand.dev/v2/best-practices/caching>
- Prompt-injection containment — <https://www.browserbase.com/blog/ai-browser-prompt-injection-containment-security>
  and <https://mlflow.org/articles/prompt-injection-defense> (dual-LLM pattern)
