# Tool registry and broker handoff

The provider-neutral registry and exact-action broker are now implemented. This is the
stable seam for the Composio/MCP workstream; provider SDK types and credentials must not
cross it.

## Core components

- `apps/api/src/core/tools/registry.ts` stores trusted `ToolDescriptor` metadata, local
  JSON schemas, MCP wire names, confirmed provider scopes, and executor references.
  Missing scopes are reported as `requires_connection` to model selection.
- `apps/api/src/core/tools/executors.ts` maps an `executorRef` to a local adapter. The
  adapter must resolve the exact destination without network I/O before authorization.
- `apps/api/src/core/tools/broker.ts` is the only sanctioned execution path. It checks
  selection and descriptor version, validates arguments with JSON Schema, constructs a
  `ToolAction`, calls `authorizeAction`, waits for exact-action approval when required,
  invokes one executor once, and records a compact result in canonical session state.
- `apps/api/src/core/tools/approval.ts` connects `ask_user` to the existing persisted
  approval and in-memory pause/resume mechanism. A revision
  (`ToolApprovalReceipt.revisedArguments`) is re-validated by `broker.ts`, which rejects
  any attempt to change the destination and reruns `authorizeAction` before executing —
  failing closed unless the revision comes back a clean allow.
- `apps/api/src/services/runtime.ts` exports `toolRegistry`, `toolExecutors`, and
  `toolBroker` for the MCP transport or a provider bootstrapper.
- `apps/api/src/providers/composio/register.ts` performs task-scoped catalog discovery,
  conservative operation classification, stable ID generation, schema registration,
  and generic executor registration. Unknown operations are skipped.
- `apps/api/src/core/mcp/server.ts` and `apps/api/src/api/mcp.routes.ts` expose the
  registry through an authenticated stateless Streamable HTTP endpoint. Every call is
  translated into exactly one broker request.

The model gateway uses the same registry. It exposes the registry's trusted schema—not
the schema supplied by Hermes—and pins the selected descriptor version in session state.
The broker refuses execution if that version changes before the call. The actual
security authority is the turn-scoped `activeToolExposureGrant`; UI-facing selected
tool fields are not authorization.

## Dynamic Composio registration

The runtime no longer needs one handwritten mapping per Composio tool. It searches the
provider catalog using the sanitized task summary, pins the returned tool version and
schema, and derives a stable AgentOS ID such as `gmail.get_profile`. A small explicit
override table remains for demo-critical names and risk policy, including
`GMAIL_SEND_EMAIL` → `mail.send`.

Classification is deterministic and conservative: read, recoverable write,
irreversible write, and destructive verbs map to descriptor baselines; an ambiguous
verb is not registered. Connection state supplies the availability and granted scopes.
Jev can raise risk for exact arguments but cannot lower these baselines.

## Registering another provider tool

At provider bootstrap, translate vendor names into stable AgentOS names and register
both halves:

```ts
toolRegistry.register({
  wireName: 'mail_send',
  descriptor: {
    id: 'mail.send',
    version: '1',
    providerId: 'composio',
    family: 'mail',
    description: 'Send one email.',
    inputSchemaRef: 'agentos://schemas/mail.send/1',
    transport: 'mcp',
    baselineEffect: 'write',
    reversibility: 'irreversible',
    requiredScopes: ['mail.send'],
    allowedDataLabels: ['public', 'private'],
    availability: 'available',
    executorRef: 'composio://mail.send',
  },
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['to', 'subject', 'body'],
    additionalProperties: false,
  },
  grantedScopes: ['mail.send'],
});

toolExecutors.register({
  ref: 'composio://mail.send',
  destinationFor: ({ arguments: args }) => /* pure local mapping, e.g. mailto:recipient */,
  execute: async (action, ctx) => ({
    output: { messageId: 'provider-message-id' },
    summary: 'Provider accepted the message.',
    sanitizedSummary: 'The approved message was sent.', // optional
    dataLabels: ['public'],
  }),
});
```

The executor should call the wrapped `toolbox` provider so the outbound request enters
the egress ledger. It must not retry external writes blindly. Use `action.id` as an
idempotency key when the provider supports one.

Mocks and fixtures must set `simulated: true`; the broker intentionally refuses to
execute them. They may still appear in catalog and selection demonstrations when the UI
labels them truthfully.

## MCP transport contract

The AgentOS-owned MCP server translates each MCP invocation into exactly one call:

```ts
await toolBroker.execute({
  sessionStateId,
  toolId: stableAgentOsToolId,
  arguments: parsedJsonArguments,
  dataLabels,
  signal,
});
```

Unknown, unselected, disconnected, unclassified, simulated, schema-invalid, version-
changed, privacy-ineligible, denied, or unapproved actions fail closed before executor
code runs. `tool.lifecycle`, `control.decided`, `approval.*`, `session.updated`, and
`harness.turn` events give the dashboard the complete trace.

## Outbound-text authenticity check (GPTZero)

`apps/api/src/core/tools/contentCheck.ts` runs between `authorizeAction` and execution
for tools that send prose in the user's name (`mail.send`, `localbrowser.type`,
`browserbase.type`). It scores the outbound text with GPTZero
(`apps/api/src/providers/gptzero/live.ts`) and is **escalate-only**: it can move the
final policy `auto -> verify -> ask_user`, never the reverse, and it can never turn
`deny` into anything or mark an unauthorized action allowed. It is also the one place in
the broker that fails **open** — a GPTZero outage or missing key leaves the
already-authorized policy untouched rather than blocking a permitted send, and the trace
records `unavailable` rather than implying the text was checked. The check is optional
(`ToolBrokerOptions.contentCheck`); omitting it disables scoring entirely.

## Verification

Run:

```bash
pnpm check:model-gateway
pnpm check:mcp-gateway
pnpm check:tool-broker
pnpm check:composio-catalog
pnpm check:content-check
pnpm typecheck
```

The gateway/broker checks cover trusted wire-name mapping, turn-grant expiry,
descriptor-version pinning, schema validation, tool-output privacy propagation, remote
secret denial, exact-action approval pause/resume, simulated-tool refusal, and single
execution after approval.
