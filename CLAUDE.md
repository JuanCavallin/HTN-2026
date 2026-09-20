## Project docs

- [docs/agentos-design.md](docs/agentos-design.md) — the AgentOS design spec. Product,
  architecture, step lifecycle, contracts, safety invariants, acceptance criteria, and
  the four-person work split. Source of truth.
- [docs/jev.md](docs/jev.md) — **what Jev is and how to call it. Read before writing any
  code that touches Jev.**
- [README.md](README.md) — what Zephyr/AgentOS is, how a run works, providers, layout.
- [docs/DEMO.md](docs/DEMO.md), [docs/SPONSORS.md](docs/SPONSORS.md),
  [docs/DEVPOST.md](docs/DEVPOST.md) — demo script, prize-track mapping, submission copy.
- [docs/frontend-handoff.md](docs/frontend-handoff.md) — the HTTP + SSE contract the UI uses.
- [docs/archive/](docs/archive/) — historical planning docs, including
  [person-3.md](docs/archive/person-3.md) (tools and browser, tracks 3A and 3B). Not current.

**Stack: TypeScript.** Settled — Person 1's Hermes adapter drives Hermes as a
subprocess over ACP (JSON-RPC on stdio), verified against a real install and merged to
`main`, so the control plane does not need to be Python. Earlier docs claimed "the design
spec describes FastAPI and SQLite"; **the spec names no stack at all** and that claim was
propagated without checking. Everything lives in `apps/api/` (TypeScript); an earlier
Python service was deleted — see `docs/archive/person-3.md`.

## Jev — the thing everyone gets wrong

**Jev cannot generate text.** It is TypeSafe AI's _System One_ model: you give it state
and typed questions, it returns a **choice, a score, or a probability**, each with
calibrated confidence. No prose, no code, no selectors, no tool calls, no loop.

**We reach Jev through the Vercel AI SDK's AI Gateway — NOT `@typesafe-ai/sdk`, and not
the OpenAI-compatible chat endpoint.** One route, one credential (`AI_GATEWAY_API_KEY`,
held in `config.providers.jev`). This is what `apps/api/src/providers/jev/live.ts`
actually does; `@typesafe-ai/sdk` is not a dependency of this repo.

```ts
import { createGateway, experimental_evaluate as evaluate } from 'ai';

const model = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY }) //
  .evaluationModel('typesafe-ai/jev');

const r = await evaluate({
  model,
  state: { page: elementTable },
  questions: {
    target: {
      type: 'choice',
      instructions: 'Which element is the login button?',
      criteria: { 1: '[1] button  Sign in', 2: '[2] link  Register' },
    },
  },
  maxRetries: 2,
  abortSignal: ctx.signal,
});
r.answers.target.choice; // -> '1'
r.answers.target.probabilities; // -> distribution, use for confidence
```

If you are writing a prompt for Jev, you are using it wrong — it takes `criteria`.
For anything generative (planning, composing text to type) use a normal model and let
Jev pick between the options it produces.

**Driving a browser with it:** build a numbered table of interactive elements from an
accessibility snapshot, ask for the operation _and_ each possible target in one request,
keep element handles server-side and let Jev return an index. Validate freshness and
occlusion before acting, and cache resolved targets so repeat runs need no model call.
Full detail, including the anti-patterns, is in [docs/jev.md](docs/jev.md).

**Person 2 owns Jev.** If you need a Jev decision and you are not Person 2, depend on a
Protocol and ship a deterministic stub behind it — the spec requires that fallback
anyway. Never skip `authorize_action` on the grounds that "Jev is safe": Jev being unable
to generate an action says nothing about whether the action it picked is authorized.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for JuanCavallin/HTN-2026, via the `gh` CLI.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`).

### Domain docs

Single-context. No `CONTEXT.md` or `docs/adr/` exists yet; the design spec and `README.md` are
the domain reference until one is written.
