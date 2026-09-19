/**
 * The provider adapter contract.
 *
 * IMPORTANT: every type in this file is OUR internal vocabulary, not any vendor's.
 * Vendor SDK types must never escape a provider's `live.ts`. That is what lets us
 * swap providers, and what lets Hermes/Jev stay unimplemented without blocking anyone.
 */

export type ProviderId =
  | 'hermes' // agent runtime (Nous Research)
  | 'jev' // fast / cheap decision layer
  | 'browserbase' // cloud browser automation
  | 'composio' // SaaS tools + OAuth brokering
  | 'anthropic' // frontier text model
  | 'gptzero'; // OUT OF SCOPE — slot only

export const PROVIDER_IDS = [
  'hermes',
  'jev',
  'browserbase',
  'composio',
  'anthropic',
  'gptzero',
] as const satisfies readonly ProviderId[];

export type ProviderMode = 'mock' | 'live' | 'disabled';

/**
 * What a provider can do, in our terms. Playbooks ask for a CAPABILITY, never a
 * vendor — so re-pointing 'decision' from jev to anthropic is a one-line change.
 */
export type Capability =
  'agent.runtime' | 'decision' | 'browser' | 'toolbox' | 'text.model' | 'content.analysis';

/** Passed to every provider call. Feeds the egress ledger. */
export interface ProviderCallContext {
  runId: string;
  stepId?: string;
  /**
   * Placeholders present in the outgoing payload. Records WHAT CLASS of data left,
   * never the value itself.
   */
  redactions?: { placeholder: string; type: string }[];
  /** Which policy rule permitted this call. Required — there is no anonymous egress. */
  policyRule: string;
  signal?: AbortSignal;
}

export interface ProviderMeta {
  provider: ProviderId;
  op: string;
  mode: ProviderMode;
  latencyMs: number;
  /** Host actually contacted. `mock://<id>` when mocked. */
  destination: string | null;
}

export type ProviderErrorCode =
  'NOT_IMPLEMENTED' | 'DISABLED' | 'AUTH' | 'RATE_LIMIT' | 'TIMEOUT' | 'UPSTREAM' | 'BAD_INPUT';

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
}

export type ProviderResult<T> =
  | { ok: true; data: T; meta: ProviderMeta }
  | { ok: false; error: ProviderError; meta: ProviderMeta };

/** Every provider implements exactly this. */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly mode: ProviderMode;
  readonly capabilities: readonly Capability[];
  health(): Promise<ProviderResult<{ detail?: string }>>;
  /** Escape hatch for ops not yet promoted to a typed capability method. */
  invoke<TIn = unknown, TOut = unknown>(
    op: string,
    input: TIn,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<TOut>>;
}

/* -------------------------------------------------------------------------- */
/* Capability interfaces — our vocabulary, deliberately narrow.               */
/* -------------------------------------------------------------------------- */

export interface AgentRuntimeAdapter extends ProviderAdapter {
  startTask(
    input: { goal: string; context?: unknown; tools?: string[] },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ taskId: string }>>;
  pollTask(
    taskId: string,
    ctx: ProviderCallContext,
  ): Promise<
    ProviderResult<{
      status: 'running' | 'done' | 'failed';
      partial?: unknown;
      result?: unknown;
      log?: string[];
    }>
  >;
  cancelTask(taskId: string, ctx: ProviderCallContext): Promise<ProviderResult<null>>;
}

export interface DecisionAdapter extends ProviderAdapter {
  /** Cheap, fast classify-or-route call. Deliberately tiny. */
  decide(
    input: { question: string; options: string[]; evidence?: string },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ choice: string; confidence: number; rationale?: string }>>;
}

export interface BrowserAdapter extends ProviderAdapter {
  openSession(
    input: { startUrl?: string },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ sessionId: string; liveViewUrl?: string }>>;
  act(
    input: { sessionId: string; instruction: string },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ url: string; screenshotUrl?: string }>>;
  extract<T = unknown>(
    input: { sessionId: string; instruction: string },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<T>>;
  closeSession(sessionId: string, ctx: ProviderCallContext): Promise<ProviderResult<null>>;
}

export interface ToolboxAdapter extends ProviderAdapter {
  listTools(
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ name: string; description: string }[]>>;
  connectUrl(app: string, ctx: ProviderCallContext): Promise<ProviderResult<{ url: string }>>;
  callTool(
    input: { name: string; args: Record<string, unknown> },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<unknown>>;
}

export interface TextModelAdapter extends ProviderAdapter {
  complete(
    input: { system?: string; prompt: string; maxTokens?: number; json?: boolean },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ text: string; tokensIn: number; tokensOut: number }>>;
}

/** GPTZero slot. Mock only — no live.ts exists. */
export interface ContentAnalysisAdapter extends ProviderAdapter {
  analyze(
    input: { text: string },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ score: number; label: string }>>;
}

/** Maps a capability to the adapter interface that serves it. */
export interface CapabilityMap {
  'agent.runtime': AgentRuntimeAdapter;
  decision: DecisionAdapter;
  browser: BrowserAdapter;
  toolbox: ToolboxAdapter;
  'text.model': TextModelAdapter;
  'content.analysis': ContentAnalysisAdapter;
}

/** Shape returned by GET /api/providers. */
export interface ProviderStatus {
  id: ProviderId;
  mode: ProviderMode;
  capabilities: readonly Capability[];
  healthy: boolean;
  detail?: string;
}
