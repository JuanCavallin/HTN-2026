/**
 * Typed API client. Every shape comes from @htn/shared, so a backend change that
 * breaks a contract is a red squiggle here rather than a runtime surprise at hour 30.
 */

import type {
  AgentGraph,
  Approval,
  ApprovalDecision,
  EgressEvent,
  GraphEdge,
  GraphNode,
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

  playbooks: () =>
    request<{ playbooks: { kind: string; title: string; directLaunch: boolean }[] }>('/playbooks'),

  /** The node tool-picker's catalog. Served by whatever backs `toolbox`. */
  tools: () =>
    request<{ tools: { name: string; description: string }[]; cached: boolean }>('/tools'),

  /**
   * Server-computed run metrics. For a LIVE run prefer calling rollup() from
   * @htn/shared directly over the useRunStream state — same function, no
   * request, and it updates with the stream.
   */
  analytics: (id: string) => request<RunAnalytics>('/runs/' + id + '/analytics'),

  /* ------------------------------------------------------------- Graphs */

  graphs: () => request<{ graphs: AgentGraph[] }>('/graphs'),

  graph: (id: string) => request<{ graph: AgentGraph }>('/graphs/' + id),

  createGraph: (body: { name?: string; description?: string }) =>
    request<{ graph: AgentGraph }>('/graphs', { method: 'POST', body: JSON.stringify(body) }),

  /**
   * Whole-document save. `version` is the copy you last read: the server
   * returns 409 if someone else saved in between, which WILL happen once chat
   * and the canvas are both writing. Re-read and merge rather than retrying
   * blind.
   */
  saveGraph: (
    id: string,
    body: { name?: string; nodes: GraphNode[]; edges: GraphEdge[]; version?: number },
  ) =>
    request<{ graph: AgentGraph }>('/graphs/' + id, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  addNode: (id: string, node: GraphNode, version?: number) =>
    request<{ graph: AgentGraph }>('/graphs/' + id + '/nodes', {
      method: 'POST',
      body: JSON.stringify({ node, version }),
    }),

  patchNode: (id: string, nodeId: string, patch: Partial<GraphNode>, version?: number) =>
    request<{ graph: AgentGraph }>('/graphs/' + id + '/nodes/' + nodeId, {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, version }),
    }),

  /** Cascades to every edge touching the node. */
  removeNode: (id: string, nodeId: string, version?: number) =>
    request<{ graph: AgentGraph }>('/graphs/' + id + '/nodes/' + nodeId, {
      method: 'DELETE',
      body: JSON.stringify({ version }),
    }),

  addEdge: (id: string, edge: GraphEdge, version?: number) =>
    request<{ graph: AgentGraph }>('/graphs/' + id + '/edges', {
      method: 'POST',
      body: JSON.stringify({ edge, version }),
    }),

  removeEdge: (id: string, edgeId: string, version?: number) =>
    request<{ graph: AgentGraph }>('/graphs/' + id + '/edges/' + edgeId, {
      method: 'DELETE',
      body: JSON.stringify({ version }),
    }),

  /** Launch a run of a graph. The run snapshots the graph as it is right now. */
  runGraph: (graphId: string, variables: Record<string, unknown> = {}) =>
    request<{ run: Run }>('/runs', {
      method: 'POST',
      body: JSON.stringify({ kind: 'graph', input: { graphId, variables } }),
    }),

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
