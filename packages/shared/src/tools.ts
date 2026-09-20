/**
 * Tool contracts — `C-1`, `C-2`, `C-3` from docs/person-3.md.
 *
 * Written by Person 3 (tracks 3A + 3B). Consumed by Person 1 (proposes actions,
 * binds approvals) and Person 2 (`authorize_action`, `select_tool_metadata`).
 *
 * THREE RULES THIS FILE ENCODES, all from the design spec's safety invariants:
 *
 *   1. `schemaRef` and `credentialRef` are POINTERS, never values. A full JSON
 *      schema and a credential both stay local; neither ever reaches Jev or any
 *      cloud model. `ToolMetadata` below is the ONLY shape that may leave.
 *   2. There is no `deny` risk class. `RiskClass` is imported from policy.ts and
 *      is `auto | verify | ask_human` — denial is expressed as a blocked
 *      `ToolAuthorization` and a `ToolResult` with `ok: false`, never a class.
 *   3. Authorization returns the destination and the provider. The executor uses
 *      what policy returned; it never reads config to pick a backend. That is
 *      what makes "local-only data never reached Browserbase" provable from the
 *      egress ledger rather than asserted.
 *
 * ADDITIVE EDITS ONLY — this package is a published API. Announce in chat first.
 */

import type { Json } from './domain.js';
import type { RiskClass } from './policy.js';
import type { ProviderId } from './providers.js';

/* -------------------------------------------------------------------------- */
/* Labels and scopes                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Sensitivity of a value, per the design spec ("public, private and secret
 * labels propagate through summaries and derived artifacts").
 */
export type DataLabel = 'public' | 'private' | 'secret';

export const DATA_LABELS = ['public', 'private', 'secret'] as const satisfies readonly DataLabel[];

/**
 * Where a step's context is allowed to be processed. This is `ModelRoute`'s
 * `contextScope` axis, NOT a data label — `local_only` is the value that must
 * never reach Browserbase, a cloud model or a remote Jev.
 *
 * OPEN QUESTION `Q-5` (Person 2 rules): the design doc's labels are
 * public/private/secret while `local_only` lives on the route. Until Person 2
 * collapses the two axes, descriptors carry BOTH `allowedDataLabels` and
 * `allowedContextScopes`. Carrying both is the conservative reading: a
 * descriptor that forgets one still fails closed on the other.
 */
export type ContextScope = 'public' | 'private' | 'local_only';

export const CONTEXT_SCOPES = [
  'public',
  'private',
  'local_only',
] as const satisfies readonly ContextScope[];

/* -------------------------------------------------------------------------- */
/* C-2 — ToolDescriptor                                                       */
/* -------------------------------------------------------------------------- */

/** How the executor actually reaches the tool. */
export type ToolTransport =
  /** An adapter compiled into this repo (the browser family). */
  | 'native'
  /** An MCP server, reached through the MCP client. */
  | 'mcp'
  /** A plain HTTP endpoint described by a plugin manifest. */
  | 'http'
  /** A fixture. MUST refuse to execute — see `simulated`. */
  | 'simulated';

/**
 * Whether this tool may be offered to Jev at all. Anything other than
 * `available` is filtered out BEFORE selection, so an unauthenticated provider
 * never appears in a candidate list.
 */
export type ToolAvailability = 'available' | 'unauthenticated' | 'unavailable' | 'disabled';

export interface ToolDescriptor {
  /** Normalised `provider.operation`, e.g. `browser.open`. Stable and unique. */
  id: string;
  /**
   * Who provides it. A string rather than `ProviderId` on purpose: a plugin
   * manifest can register a provider this repo has never heard of. Our own
   * adapters use a `ProviderId` value here.
   */
  providerId: string;
  /** Selection unit. Jev picks families first, then tools within them. */
  family: string;
  /** One short line. This DOES reach Jev, so it carries no secrets. */
  description: string;
  /** POINTER to the full JSON schema, which stays local. Never the schema. */
  schemaRef: string;
  transport: ToolTransport;
  riskClass: RiskClass;
  /** OAuth-style scopes the credential must already hold. */
  requiredScopes: readonly string[];
  /** Sensitivity this tool may receive. A `secret` payload to a cloud tool blocks. */
  allowedDataLabels: readonly DataLabel[];
  /** Context scopes this tool may serve. Omitting `local_only` bars local-only steps. */
  allowedContextScopes: readonly ContextScope[];
  availability: ToolAvailability;
  /** POINTER into the executor table. Never a function, never a URL with auth. */
  executorRef: string;
  /** Bumped when args or behaviour change. Approvals bind to this. */
  version: string;
  /** A labelled fixture. Attempting to execute one is an ERROR, not a no-op. */
  simulated: boolean;
  /** POINTER to a credential held locally. Never a credential value. */
  credentialRef?: string;
}

/**
 * The ONLY projection of a descriptor that may leave the machine.
 *
 * `schemaRef`, `credentialRef`, `executorRef` and `requiredScopes` are all
 * omitted: they are local routing detail, and two of them are pointers at
 * things Jev must never see. `select_tool_metadata` returns this shape for
 * candidates and the full descriptor only for the final selected set.
 */
export type ToolMetadata = Pick<
  ToolDescriptor,
  | 'id'
  | 'providerId'
  | 'family'
  | 'description'
  | 'riskClass'
  | 'allowedDataLabels'
  | 'allowedContextScopes'
  | 'availability'
  | 'simulated'
  | 'version'
>;

export function toToolMetadata(descriptor: ToolDescriptor): ToolMetadata {
  return {
    id: descriptor.id,
    providerId: descriptor.providerId,
    family: descriptor.family,
    description: descriptor.description,
    riskClass: descriptor.riskClass,
    allowedDataLabels: descriptor.allowedDataLabels,
    allowedContextScopes: descriptor.allowedContextScopes,
    availability: descriptor.availability,
    simulated: descriptor.simulated,
    version: descriptor.version,
  };
}

/* -------------------------------------------------------------------------- */
/* C-3 — ToolAction and ToolResult                                            */
/* -------------------------------------------------------------------------- */

/**
 * Exactly what is about to run. This is what `authorize_action` receives, and
 * what an approval binds to — `actionId` + `descriptorVersion` + `destination`,
 * per the design spec's human-intervention contract.
 *
 * Schema hiding is an optimisation, not authorization: the gate re-checks THIS
 * object immediately before execution, regardless of what was exposed earlier.
 */
export interface ToolAction {
  runId: string;
  stepId: string;
  /** Unique per proposed action. An approval is bound to exactly one. */
  actionId: string;
  toolId: string;
  /** The descriptor version in force when the action was proposed. */
  descriptorVersion: string;
  /** The exact arguments. Shown verbatim in the approval panel — no summarising. */
  args: Record<string, Json>;
  /**
   * Where this would go, as a proposal. Policy may override it in
   * `ToolAuthorization.destination`; the executor uses policy's value.
   */
  destination: string;
  /** Sensitivity of the data carried by `args`. */
  dataLabels: readonly DataLabel[];
  /** The step's context scope. `local_only` bars every remote destination. */
  contextScope?: ContextScope;
}

export interface ToolError {
  code:
    'BLOCKED' | 'UNKNOWN_TOOL' | 'UNAVAILABLE' | 'SIMULATED' | 'BAD_INPUT' | 'TIMEOUT' | 'UPSTREAM';
  message: string;
  /** Which rule or failure path produced this. Rendered in the trace. */
  reason?: string;
}

/**
 * Discriminated on `ok` so a successful branch cannot read `error` and vice
 * versa. The field list is exactly `C-3`'s.
 */
export type ToolResult<T = Json> =
  | {
      actionId: string;
      ok: true;
      output: T;
      error?: undefined;
      /** Where it ACTUALLY went. The ledger proof, not the proposal. */
      destination: string;
      latencyMs: number;
    }
  | {
      actionId: string;
      ok: false;
      output?: undefined;
      error: ToolError;
      destination: string;
      latencyMs: number;
    };

/* -------------------------------------------------------------------------- */
/* The authorization protocol (Person 2 implements; 3A/3B depend on it)       */
/* -------------------------------------------------------------------------- */

/**
 * Person 2's answer for one exact `ToolAction`.
 *
 * There is deliberately no `'maybe'`. Anything that is not `outcome: 'allow'`
 * blocks, and so does a thrown error, a timeout, or no response at all — four
 * fail-closed paths, all of which the executor treats identically.
 */
export interface ToolAuthorization {
  outcome: 'allow' | 'deny';
  /** Typed reason code, e.g. `irreversible-action-requires-approval`. */
  reason: string;
  riskClass: RiskClass;
  /**
   * The destination policy permits. The executor MUST use this rather than
   * reading config — it is how seam 3 (local vs Browserbase) is enforced.
   */
  destination?: string;
  /** Which of our providers may serve it. Same reason as `destination`. */
  providerId?: ProviderId;
  /**
   * Arguments a human edited during approval. When present, THESE execute —
   * never the payload the human edited away. Policy has already reauthorized
   * them before returning them here.
   */
  revisedArguments?: Record<string, Json>;
}

/**
 * The seam-2 protocol. Person 2 owns the implementation; 3B ships a
 * deterministic stopgap over `core/risk.ts` until then.
 */
export type AuthorizeAction = (
  action: ToolAction,
  signal?: AbortSignal,
) => Promise<ToolAuthorization>;

/* -------------------------------------------------------------------------- */
/* S-2 — the executor interface                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every executor — MCP, HTTP, browser — is this one function.
 *
 * The implementation is responsible for calling `authorize_action` itself. A
 * caller cannot forget the gate, because there is no unguarded entry point.
 */
export interface ToolExecutor {
  /** Which `executorRef` values this executor serves. */
  readonly ref: string;
  execute(action: ToolAction, signal?: AbortSignal): Promise<ToolResult>;
}

/* -------------------------------------------------------------------------- */
/* S-3 — browser tool ids                                                     */
/* -------------------------------------------------------------------------- */

/** The browser family's stable tool ids. 3B owns these; 3A registers them. */
export const BROWSER_TOOL_IDS = [
  'browser.search',
  'browser.open',
  'browser.extract',
  'browser.inspect',
  'browser.click',
  'browser.type',
  'browser.submit',
  'browser.close',
] as const;

export type BrowserToolId = (typeof BROWSER_TOOL_IDS)[number];

export const BROWSER_FAMILY = 'browser';
