/**
 * Typed API client. Every shape comes from @htn/shared, so a backend change that
 * breaks a contract is a red squiggle here rather than a runtime surprise at hour 30.
 */

import type {
  Approval,
  ApprovalDecision,
  EgressEvent,
  PiiSpan,
  Run,
  RunAnalytics,
  Step,
  ProviderStatus,
  Capability,
  ProviderId,
} from '@htn/shared';

export interface RunDetail {
  run: Run;
  steps: Step[];
  approvals: Approval[];
  egress: EgressEvent[];
  piiSpans: PiiSpan[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api' + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? res.statusText,
    );
  }

  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; uptimeSeconds: number }>('/health'),

  providers: () =>
    request<{ providers: ProviderStatus[]; bindings: Record<Capability, ProviderId> }>(
      '/providers',
    ),

  playbooks: () => request<{ playbooks: { kind: string; title: string }[] }>('/playbooks'),

  /** The node tool-picker's catalog. Served by whatever backs `toolbox`. */
  tools: () =>
    request<{ tools: { name: string; description: string }[]; cached: boolean }>('/tools'),

  /**
   * Server-computed run metrics. For a LIVE run prefer calling rollup() from
   * @htn/shared directly over the useRunStream state — same function, no
   * request, and it updates with the stream.
   */
  analytics: (id: string) => request<RunAnalytics>('/runs/' + id + '/analytics'),

  listRuns: () => request<{ runs: Run[] }>('/runs'),

  createRun: (kind: string, input: unknown) =>
    request<{ run: Run }>('/runs', { method: 'POST', body: JSON.stringify({ kind, input }) }),

  getRun: (id: string) => request<RunDetail>('/runs/' + id),

  cancelRun: (id: string) => request<{ run: Run }>('/runs/' + id + '/cancel', { method: 'POST' }),

  decide: (approvalId: string, decision: ApprovalDecision) =>
    request<{ approval: Approval }>('/approvals/' + approvalId + '/decide', {
      method: 'POST',
      body: JSON.stringify(decision),
    }),
};
