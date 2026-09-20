# Provider Setup

The model side is ready locally. OpenRouter and Ollama are both enabled in the ignored
root `.env`; provider health reports both live. OpenRouter is cloud-only. Ollama is the
true local/private route.

## Model tiers

```dotenv
OPENROUTER_MODE=live
OPENROUTER_API_KEY=...
OPENROUTER_CHEAP_MODEL=openai/gpt-5.6-luna
OPENROUTER_FRONTIER_MODEL=openai/gpt-5.6-sol

OLLAMA_MODE=live
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:8b
```

Gemini is a **third** model backend and a second cloud vendor:

```dotenv
GEMINI_MODE=live
GEMINI_API_KEY=...
GEMINI_CHEAP_MODEL=gemini-3.5-flash-lite
GEMINI_FRONTIER_MODEL=gemini-3.8-flash
```

This is a direct Google route, not Gemini-via-OpenRouter, and the distinction is the
point: it is a different destination in the egress ledger, a different bill and a
different failure domain. Left at `mock` it advertises no routes at all, so nothing can
silently fall back to it.

Model ids move. `GET /api/providers` checks both configured ids against what the key can
actually list and reports an unhealthy provider naming the missing ones, so a renamed
model surfaces on the providers page instead of mid-demo.

Jev chooses only among routes AgentOS first deems privacy-eligible. Public work may use
either OpenRouter tier or either Gemini tier; `secret` or `local_only` state can use only
Ollama. Tool schemas are filtered by AgentOS before any backend receives them — and a
backend that returns a tool call AgentOS did not expose that turn has the call refused,
not executed.

## GPTZero — outbound-text check

```dotenv
GPTZERO_MODE=live
GPTZERO_API_KEY=...
GPTZERO_ESCALATION_THRESHOLD=0.75
```

Not a detector on inbound content. It scores the prose AgentOS is about to send **in the
user's name** — a `mail.send` body, a `*.type` field value — immediately before the tool
broker executes it, and escalates the action to human approval when P(ai) crosses the
threshold.

Three properties make it safe to leave on, all enforced by `pnpm check:content-check`:

- **Escalate-only.** It can move a policy `auto -> verify -> ask_user`, never the other
  way, and it can never mark an action allowed. Authorization is settled upstream.
- **Fails open.** A GPTZero outage, rate limit or missing key leaves the policy exactly
  as authorization set it, and the trace records `content_check_unavailable` rather than
  implying the text passed. This is the one place in the broker that does not fail closed,
  because failing closed would let an advisory outage block permitted sends.
- **Scores prose only.** Recipients, subjects, URLs, denied actions, read-only tools and
  short strings are never sent and never spend a call.

At `mock` it returns a deterministic low score, so the path runs end to end with no key.

## Sentry — tracing and logs

```dotenv
SENTRY_DSN=https://...ingest.sentry.io/...
SENTRY_TRACES_SAMPLE_RATE=1
```

Inert without a DSN — no spans, no logs, no network — so the keyless clone is unaffected.

- **Tracing:** one span per outbound provider call, created by the same `withEgress`
  proxy that writes the ledger row. An untraced provider call is therefore unreachable
  for the same structural reason an unlogged one is. Span attributes come from the ledger
  entry, so the span and the ledger cannot disagree about cost or destination.
- **Logs:** one structured log per `RunEvent`, forwarded from the run bus — the single
  documented path by which progress escapes the orchestrator.
- **Errors:** genuinely unhandled faults only; 404s and refused revisions are the API
  working and are not reported.

Spans and logs carry the _shape_ of a call — provider, destination, latency, tokens,
cost, policy rule, and the _class_ of any redacted span (`pii.email`) — never prompts,
tool arguments or model output. Sentry is not a declared egress destination in the
ledger and must not become one by accident.

## Composio

Create a Composio project and a Gmail auth config, then add:

```dotenv
COMPOSIO_MODE=live
COMPOSIO_API_KEY=...
COMPOSIO_USER_ID=agentos-demo-user
COMPOSIO_AUTH_CONFIG_ID=...
# Optional reviewed tool registered at startup.
COMPOSIO_TOOL_SLUGS=GMAIL_SEND_EMAIL
# Optional comma-separated catalog scope; empty searches all toolkits.
COMPOSIO_TOOLKITS=
COMPOSIO_DISCOVERY_LIMIT=24
```

Restart the API, then:

1. `POST /api/providers/composio/connect` and open the returned `url` in the user's browser.
2. Complete Gmail OAuth.
3. `POST /api/providers/composio/refresh`.
4. Confirm `GET /api/providers/composio/tools` reports `connected: true` and
   `GET /api/tools` reports `mail.send` as available.

At task start, AgentOS searches Composio with a public or explicitly sanitized task
summary, imports exact versioned schemas, and classifies operations locally. Unknown
operations fail closed. Jev reduces the resulting metadata to a small tool set before
Hermes starts, and the model gateway filters it again on every model request. Hermes
sees selected tools only through AgentOS MCP; Composio's MCP server is never connected
directly because that would bypass the broker.

Sending is classified as an irreversible write, so the broker pauses for approval of
the exact recipient and arguments before Composio runs. `secret` and `local_only` tasks
skip remote catalog search entirely.

The dashboard can preview the same catalog path with:

```http
POST /api/tools/discover
Content-Type: application/json

{"query":"send an email through Gmail","toolkits":["gmail"],"limit":12}
```

To launch a real supervised objective without a product-specific playbook:

```http
POST /api/runs
Content-Type: application/json

{"kind":"agent","input":{"goal":"Send an email to ..."}}
```

The ignored `.env` already holds local credentials on the configured demo machine.
Never commit them; rotate any credential pasted into chat or logs.

## Browser tools

The imported browser family now uses the same AgentOS registry, Jev reduction,
exact-action broker, approval gate, MCP endpoint, and activity stream as Composio and
generic MCP tools. There is no second browser-only authorization path.

For Browserbase:

```dotenv
BROWSERBASE_MODE=live
BROWSERBASE_API_KEY=...
BROWSERBASE_PROJECT_ID=...
```

For private on-device browser execution, install Chrome and use:

```dotenv
LOCALBROWSER_MODE=live
LOCALBROWSER_CHANNEL=chrome
```

AgentOS registers `browserbase.*` only when Browserbase is live and `localbrowser.*`
only when the local provider is live. Browserbase candidates exclude `secret` and
`local_only` state. The local executor additionally refuses to send sensitive state to
a non-loopback website. Click/type operations use a bounded element table and Jev target
selection; low-confidence targets fail closed. `*.submit` is irreversible and pauses for
human approval before the browser executor runs.

## Generic MCP connections

AgentOS can connect to any HTTP Streamable MCP server without exposing that server
directly to Hermes. Add a connection through `POST /api/mcp-connections`:

```json
{
  "name": "Company tools",
  "url": "https://mcp.example.com/mcp",
  "headerEnv": { "Authorization": "COMPANY_MCP_AUTH_HEADER" }
}
```

`headerEnv` values are environment-variable names. Put the complete header value (for
example `Bearer ...`) in the ignored root `.env`; credentials are never stored in
SQLite or returned by the API. Use `GET /api/mcp-connections` to inspect status,
`POST /api/mcp-connections/:id/refresh` after a server catalog changes,
`PATCH /api/mcp-connections/:id` with `{"enabled":false}` to disconnect, and
`DELETE /api/mcp-connections/:id` to remove it.

Tool names are classified conservatively. Known reads and writes enter the registry;
irreversible/destructive names retain approval requirements; unknown operations remain
visible but unavailable. Every executable call still goes through AgentOS schema,
selection, privacy, exact-action authorization, approval, and egress logging.

## Persistence and activity replay

Set `PERSIST_TO_DISK=true` to use SQLite at `SQLITE_PATH`. The event log is replayable
as SSE at `/api/runs/:id/stream` or as JSON at `/api/runs/:id/events?since=0`.

## Checks

```bash
pnpm typecheck
pnpm check:providers
pnpm check:model-gateway
pnpm check:mcp-gateway
pnpm check:mcp-connections
pnpm check:tool-broker
pnpm check:composio-catalog
pnpm check:browser-tools
pnpm check:sqlite-store
pnpm check:content-check
pnpm check:gemini
```
