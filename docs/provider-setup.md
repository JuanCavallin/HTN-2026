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

Jev chooses only among routes AgentOS first deems privacy-eligible. Public work may use
either OpenRouter tier; `secret` or `local_only` state can use only Ollama. Tool schemas
are filtered by AgentOS before either backend receives them.

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
```
