# Devpost submission — copy/paste sheet

Everything the Devpost form asks for, in form order. `TODO(team)` marks the only things
that cannot be answered from the repo. Do not submit a `TODO`.

**Deadlines:** sponsor prize selection locks **Saturday 2:00 PM EDT**. Judging is a live
demo — see [DEMO.md](DEMO.md). Prize reasoning is in [SPONSORS.md](SPONSORS.md).

---

## Project name

Zephyr

## Tagline (≤ 200 chars)

A control plane for AI agents: a tiny decision model picks the model, the tools and the
moment to stop — and nothing private or irreversible leaves without policy saying yes.

## Project story (Markdown — paste into "About the project")

```markdown
## Inspiration

We gave an agent harness real credentials and watched it work. It was impressive and
unnerving in equal measure: every step went to the most expensive model, it could see every
tool we owned, our data went wherever it decided, and the first time we learned it was
about to send an email was after it had sent it. Agents today are a black box holding your
keys. We wanted the opposite: an agent you can _supervise_ — and that gets cheaper and
more private because of it, not in spite of it.

## What it does

Zephyr sits between any agent harness and the world. You type a goal; Zephyr runs it as a
supervised task:

- **Routes every step.** A tiny decision model (Jev) classifies each step on two axes —
  private vs cloud, low vs high intelligence — and sends it to a local model, a cheap cloud
  model, or a frontier model. Most steps don't need the frontier.
- **Narrows the tools.** From a registry of browser tools, 1000+ Composio integrations and
  any MCP server you add, the agent is handed only the few tools this step needs. It cannot
  call what it was never shown.
- **Guards what leaves.** Sensitive spans are detected and replaced with `[[PII_n]]`
  placeholders before any cloud call. Every outbound call lands in an egress ledger:
  destination, class of data, and the rule that allowed it.
- **Stops before the irreversible.** Actions are classified by reversibility. Sending an
  email or submitting a form pauses the run and shows you the exact action. Approve, reject,
  or edit it — an edit is re-authorized and can only narrow the action. Text written in your
  name is scored by GPTZero first; a high AI-probability can add a human check, never waive one.
- **Knows when it's done — or stuck.** Jev judges completion from canonical session state.
  `blocked` pauses for a human instead of burning turns.
- **Shows its work.** A live, replayable trace of every decision, model call, tool call and
  approval, plus a side-by-side comparison against a single-LLM-call baseline (tokens, cost,
  latency). You can pause, resume and cancel any run.

It drives real browsers (Browserbase in the cloud, local Chrome for private data), and runs
parallel browser workers as a swarm.

## How we built it

A TypeScript pnpm monorepo: an Express 5 API, a React + Vite dashboard, and a shared package
of zod schemas that both sides import, so the event stream is one contract.

- **Harness-agnostic core.** The harness (Hermes, from Nous Research) runs as a subprocess
  over the Agent Client Protocol. It is pointed at _our_ OpenAI-compatible model gateway
  (`/v1`) and _our_ MCP server (`/mcp`), so every model call and every tool call passes
  through Zephyr's policy whether the harness likes it or not.
- **Jev as System One.** Jev (TypeSafe AI, via the Vercel AI Gateway) cannot generate text.
  We hand it state plus typed questions and get back a choice with calibrated confidence. It
  picks routes, tool families, tools, browser targets (by index into an element table built
  from the accessibility tree) and completion. Below a confidence threshold, or when its time budget runs
  out (2 s for an interactive browser step), a deterministic rule decides instead — and the trace says which one did.
- **An exact-action broker.** Tools enter a reviewed registry with a reversibility class.
  The broker authorizes the _exact_ proposed action — arguments, destination, data labels —
  not the tool in general. Unknown tools from a newly added MCP server are discovered but
  stay unavailable until classified: fail-closed.
- **Providers behind capabilities.** Playbooks ask for `browser` or `text.model`, never a
  vendor. Every provider has a mock twin, and a missing key downgrades live → mock instead
  of crashing, so the full demo runs from a fresh clone with no keys at all.
- **Streaming and persistence.** Runs stream over SSE with monotonic ids and `Last-Event-ID`
  replay; events persist to SQLite so a finished run rebuilds from history.
- **Invariants as tests.** Eleven `check:*` suites pin the safety properties (secret egress
  blocked, revised approvals re-authorized, fail-closed tools, outbound-text check is
  escalate-only), run in CI with the typecheck and web tests.

## Challenges we ran into

- **Designing for a model that can't talk.** Our first instinct was to prompt Jev. It takes
  criteria, not prompts, and returns an index, not prose. Rebuilding browser control around
  "here is a numbered table of elements — which one?" was the unlock, and it made the system
  safer: a model that can't write text can't be talked into inventing an action.
- **Supervising a harness we don't control.** Hermes has its own loop and its own ideas.
  Putting it behind our model and MCP gateways — and correlating its calls back to the right
  run — is what made policy enforceable rather than advisory.
- **Four people, one event contract.** Backend and frontend drifted mid-weekend: the UI was
  still calling graph-synthesis endpoints the backend had replaced with the agent playbook.
  Shared zod types caught the shape errors; an end-to-end audit caught the missing routes.
- **"Safe" is a separate question from "authorized".** Jev being unable to generate an
  action says nothing about whether the action it picked is allowed. Every path still goes
  through deterministic authorization, and we wrote tests so nobody can shortcut that.
- **Honest mocks.** Making the keyless demo complete without ever labelling a mock as live
  took real discipline in the UI and the provider layer.

## Accomplishments that we're proud of

- A run that pauses on an irreversible action, shows the exact payload, and resumes on
  approval — against real services, from a plain sentence.
- An egress ledger that turns "your private data never reached the cloud browser" from a
  claim into a row you can point at.
- A working comparison that shows what supervision costs and saves versus one big LLM call.
- The whole thing boots and demos from `pnpm install && pnpm dev` with zero keys.

## What we learned

- Small, calibrated, non-generative models are a better fit for control decisions than
  LLMs: faster, cheaper, thresholdable, and not injectable.
- Classify by **reversibility**, not by vague "risk". It is the question a human actually
  needs answered before an agent acts.
- Make the safe path the only path: gateways the harness can't route around beat guidelines
  the harness is asked to follow.
- Build the mock twin first. It is demo insurance and it keeps four people unblocked.

## What's next for Zephyr

- More harness adapters (the adapter boundary is already there) so the same policy layer
  supervises any agent.
- Editing a node of a _running_ workflow, with the same re-authorization rules as revised
  approvals.
- Per-user auth and policy packs — budgets, approval thresholds, data residency — for teams.
- Caching resolved browser targets so repeat runs need no model call at all.
- Using the ledger and approval history to learn which steps never needed the frontier.
```

## Built with (tags, max 25)

`typescript` `node.js` `express` `react` `vite` `tailwindcss` `react-flow` `zod` `sqlite`
`server-sent-events` `pnpm` `github-actions` `model-context-protocol` `agent-client-protocol`
`hermes` `jev` `typesafe-ai` `vercel-ai-sdk` `vercel-ai-gateway` `browserbase` `stagehand`
`playwright` `composio` `gptzero` `anthropic-claude`

Swap in `gemini`, `openrouter`, `ollama` or `sentry` for the last tags if you claim those
prizes — tags should match the prize list.

## "Did you implement a generative AI model or API in your hack this weekend?"

Yes. Zephyr is a control plane _for_ generative AI, and uses it in three ways:

1. **Anthropic Claude** summarises documents after sensitive spans are replaced with
   placeholders, so the cloud model never sees the raw values.
2. **Hermes (Nous Research)** is the agent harness that plans and proposes tool calls. Its
   model calls go through Zephyr's OpenAI-compatible gateway, which routes each one to
   **Ollama** (local/private), **OpenRouter** (cheap or frontier cloud) or **Google Gemini**
   based on the data's privacy label and the difficulty of the step.
3. **GPTZero's** detection API scores outbound text the agent writes in the user's name
   before it is sent, and can force a human review.

Why: the point of the project is that generative models should not decide what they are
allowed to do. The decisions _about_ them — which model, which tools, is it done — are made
by **Jev**, a non-generative decision model that returns a choice with calibrated confidence,
with deterministic policy as the final authority.

## "Which of the following AI tools did you use this weekend?"

- **Claude Code** — yes (commit trailers in the repo).
- `TODO(team)`: tick **Devin** only if someone actually used it (`.devin/` skills are in the
  repo), and **Codex / ChatGPT**, **Copilot**, **Cursor** likewise. Tick only what is true;
  the OpenAI and Cognition prizes both ask for a concrete story.

## Gemini project number (only if claiming MLH Best Use of Gemini)

`TODO(team)`: Google AI Studio → the project that owns `GEMINI_API_KEY` → project number
(digits, not the project id). Only claim it if a run's `model.lifecycle` event shows a
Gemini model actually serving a call on the demo machine.

## Technology feedback (name the tech you are reviewing)

Drafts from what we hit while building. `TODO(team)`: edit to match your own experience.

- **Jev / TypeSafe AI (via Vercel AI Gateway):** Typed questions with calibrated
  probabilities made thresholds and fallbacks straightforward. The mental shift from prompts
  to criteria is the main learning curve; more end-to-end examples of state + questions for
  multi-decision requests would shorten it. Batching several questions in one request kept
  browser steps interactive.
- **Browserbase + Stagehand:** Sessions were reliable and the live view is great for demos.
  We hit the project concurrency limit and found that the session replay/recording endpoint
  returns 404 and the live-view URL expires once a session stops — clearer docs on what
  survives a closed session would have saved time.
- **Composio:** Discovery plus delegated OAuth removed all the Gmail glue code. Version
  pinning for tools mattered for us because we review each tool's reversibility; a
  machine-readable "this tool has side effects" flag in the catalog would let agents gate
  irreversible actions without a hand-maintained list.
- **GPTZero:** Simple API, fast enough to sit inline before a send. A documented recommended
  threshold for short texts (emails are short) would help.
- **Hermes (Nous Research):** ACP made it possible to drive the harness as a subprocess and
  point it at our own model and MCP endpoints, which is what made supervision enforceable.

## Submission checklist

- [ ] Repo link: https://github.com/JuanCavallin/HTN-2026 (public, includes design assets
      under `apps/web/` and `.devin/design/`)
- [ ] Badge ID of every team member, exactly as printed under the QR code — `TODO(team)`
- [ ] Sponsor prizes selected before **Sat 2:00 PM EDT** — list in [SPONSORS.md](SPONSORS.md)
- [ ] Demo video (optional, recommended) — record the 3-minute script in [DEMO.md](DEMO.md)
- [ ] Screenshots: composer, live trace with a Jev decision card, approval panel, egress
      ledger, compare page
- [ ] No `TODO(team)` left in anything you pasted
