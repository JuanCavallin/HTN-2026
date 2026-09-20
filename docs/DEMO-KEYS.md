# Keys and setup for the person running the demo

What has to be in the root `.env` — and installed on the laptop — for each part of the
[demo](DEMO.md) to be **live**. Everything is optional: a missing key downgrades that
provider to mock, it never crashes. The rule for demo day is simply that you may only
_say_ "live" for what `GET /api/providers` shows as `live` **and** healthy.

`.env` lives at the repo root, is gitignored, and is read once at API start.
**Restart `pnpm dev` after every edit.**

## The short version

| Tier                       | What you can demo                                                                              | You need                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **0 — nothing**            | The whole **Demo run** playbook, approvals, ledger, compare. All providers labelled mock.      | Nothing. `pnpm install && pnpm dev`.                   |
| **1 — the shared team keys** | Live Jev decisions, live Browserbase swarm, live Claude summary, live Composio catalog + Gmail. | The team `.env` (4 keys, below). No installs.          |
| **2 — the headline demo**  | Type "send an email to…" → agent proposes it → approval → it really sends.                     | Tier 1 **plus Hermes installed on this laptop**.       |
| **3 — sponsor extras**     | Private local-model route, GPTZero gate, Gemini route, Sentry traces.                          | Ollama install; GPTZero, Gemini, Sentry keys (booths). |

The demo laptop should be at **Tier 2**. Tier 3 items are each independent.

## Keys

"Shared" means the team already has a working key in the team `.env`; you do not need your
own. All teammates then share one quota, so do not leave runs looping.

| Provider (what it does in the demo)                                                                         | `.env`                                                                                     | Shared?                    | Where a new one comes from                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------ |
| **Jev** — every routing / tool / completion decision. Without it, decisions are deterministic fallbacks.   | `JEV_MODE=live` `AI_GATEWAY_API_KEY=vck_…`                                                  | Yes (two keys)             | Vercel dashboard → AI Gateway → API keys. It is a _Vercel AI Gateway_ key, not a TypeSafe key. |
| **Browserbase** — cloud browser, the 3-worker swarm.                                                        | `BROWSERBASE_MODE=live` `BROWSERBASE_API_KEY=bb_live_…` `BROWSERBASE_PROJECT_ID=…`          | Yes                        | browserbase.com → Settings. Booth gives 100 browser-hours.                                  |
| **Anthropic** — the redacted cloud summary step.                                                            | `ANTHROPIC_MODE=live` `ANTHROPIC_API_KEY=sk-ant-…`                                          | Yes                        | console.anthropic.com → API keys.                                                           |
| **Composio** — Gmail send (the irreversible action that triggers approval).                                 | `COMPOSIO_MODE=live` `COMPOSIO_API_KEY=ak_…` `COMPOSIO_AUTH_CONFIG_ID=ac_…` `COMPOSIO_USER_ID=agentos-demo-user` `COMPOSIO_TOOL_SLUGS=GMAIL_SEND_EMAIL` | Yes, Gmail already connected | platform.composio.dev → project → API key, plus a **Gmail auth config** (its id is `ac_…`). |
| **OpenRouter** — cheap + frontier cloud model routes for the agent.                                         | `OPENROUTER_MODE=live` `OPENROUTER_API_KEY=sk-or-…`                                         | Yes                        | openrouter.ai → Keys.                                                                       |
| **GPTZero** — scores outbound text before it is sent. _Sponsor prize._                                      | `GPTZERO_MODE=live` `GPTZERO_API_KEY=…`                                                     | **No key yet**             | GPTZero booth / gptzero.me → API. Until then leave `GPTZERO_MODE=mock`.                     |
| **Gemini** — second cloud model vendor. _MLH prize; Devpost also wants the project number._                 | `GEMINI_MODE=live` `GEMINI_API_KEY=…`                                                       | **No key yet**             | aistudio.google.com → Get API key. Note the project **number** for Devpost.                 |
| **Sentry** — tracing + logs. _Sponsor prize._                                                               | `SENTRY_DSN=https://…ingest.sentry.io/…`                                                    | **No DSN yet**             | sentry.io → new Node project → Client Keys (DSN).                                           |

With the shared Composio key, mail is sent **from whichever Gmail account the teammate
connected**. To send from your own: make your own Composio project + Gmail auth config, set
the two values, restart, open `/connections` → Composio → **Connect**, finish Google OAuth,
press **Refresh**, and confirm `mail.send` shows `available`. Pick a recipient address you
control for the demo.

## Not keys — things that must be installed on the demo laptop

These cannot be shared through `.env`, which is why a copied `.env` is not enough.

### Hermes (required for Tier 2)

The agent harness runs as a local subprocess (`uv run hermes-acp`). There is no Hermes API
key — its model calls go through Zephyr's own gateway, so the model keys above are the ones
that matter.

1. Install `uv` (astral.sh/uv) and make sure `uv --version` works in a **new** terminal.
2. Get a `hermes-agent` checkout (Nous Research). The official installer puts it at
   `~/.hermes/hermes-agent`.
3. In that folder: `uv sync --extra acp --extra mcp --locked`
4. In `.env`: `HERMES_MODE=live` and `HERMES_CWD=<absolute path to that folder>`.
   Leave `HERMES_BASE_URL` blank.

`HERMES_CWD` is an absolute path on _your_ disk. A teammate's value (`C:\Users\juanc\…`,
`/Users/sheharyar…`) will not exist on your machine; the API then prints
`HERMES_CWD does not exist on this machine; hermes -> mock` and carries on in mock.

**Without live Hermes** the free-form composer still runs, but mock Hermes never proposes a
tool call, so the completion judge reports `blocked` and the run pauses. Use the **Demo run**
playbook instead — it shows approval, swarm, redaction and the ledger on any laptop.

### Ollama (Tier 3 — the private/local model route)

1. Install Ollama, then `ollama pull qwen3:8b` (≈5 GB; wants ~8 GB free RAM while running).
2. `.env`: `OLLAMA_MODE=live` `OLLAMA_BASE_URL=http://127.0.0.1:11434` `OLLAMA_MODEL=qwen3:8b`

If Ollama is not running, leave `OLLAMA_MODE=mock`. `live` with no daemon shows as
**live + unhealthy**, and a task labelled private will fail to find its route.

### Chrome (the private browser route)

Google Chrome installed, then `LOCALBROWSER_MODE=live` `LOCALBROWSER_CHANNEL=chrome`. No key.

## Settings to have on for the demo

```dotenv
MOCK_ALL=false
PERSIST_TO_DISK=true          # finished runs replay offline if the wifi dies
BROWSER_MAX_SESSIONS=2        # raise to 3 if you want all three swarm workers at once
```

`MOCK_ALL=true` is the panic switch: everything goes mock, the demo still runs.

## Pre-flight (5 minutes before judges arrive)

1. `pnpm dev`, then read the API's first log line:
   `[config] providers: hermes=live jev=live browserbase=live …` — that is the truth.
2. Open **`/connections`** (or `GET http://localhost:8787/api/providers`). Every provider you
   plan to mention must read **Live** and **Healthy**. Composio must show Gmail connected,
   and the tool inventory must list `mail.send` as `available`.
3. Header button reads **Hermes** with a green dot (not "Hermes · Mock").
4. On `/`, switch the composer from **Preview mode** to **Use backend**.
5. `pnpm test:jev` — one real Jev decision end to end.
6. Run the **Demo run** playbook once, approve it, and leave that finished run open in a tab.
7. Do one full email rehearsal to an address you own.

## When something is not live

| You see                                           | Cause                                                        | Fix                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Provider shows **Mock** though the key is set     | `<PROVIDER>_MODE` is not `live`, or the API was not restarted | Set `_MODE=live`, restart `pnpm dev`.                                    |
| `hermes -> mock` warning at boot                  | `HERMES_CWD` path is not on this machine                     | Point it at your own checkout.                                           |
| Run fails with `spawn uv ENOENT`                  | `uv` not on PATH for the API's shell                         | Install `uv`, open a new terminal, restart.                              |
| Agent run pauses as `blocked` immediately         | Hermes is mock                                               | Install Hermes, or use the Demo run playbook.                            |
| Ollama **Live** but unhealthy                     | Daemon not running / model not pulled                        | `ollama serve`, `ollama pull qwen3:8b`, or set `OLLAMA_MODE=mock`.       |
| `mail.send` is `requires_connection`              | Gmail OAuth not completed for this `COMPOSIO_USER_ID`        | `/connections` → Composio → Connect → Refresh.                           |
| Jev decisions show `source: fallback`             | Gateway key invalid or rate-limited                          | Swap to the spare `AI_GATEWAY_API_KEY` commented in the team `.env`.     |
| Browserbase errors under load                     | Session cap / project concurrency                            | Keep `BROWSER_MAX_SESSIONS` low; cancel stuck runs.                      |
| A second agent run fails while one is active      | By design: one live Hermes run at a time                     | Wait for, or cancel, the first run.                                      |

## Handling the keys

- Never commit `.env`; never paste keys into Devpost, slides, or a screen share. `/connections`
  and `/api/providers` never display key values, so they are safe to show.
- The team keys have been pasted into chat. **Rotate all of them after the event**
  (Anthropic, OpenRouter, Browserbase, Composio, Vercel AI Gateway).
- MCP servers added on `/connections` take the **name** of an env var for their auth header,
  never the secret itself; put the value in `.env`.
