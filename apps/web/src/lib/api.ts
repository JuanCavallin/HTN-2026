/**
 * Typed API client. Every shape comes from @htn/shared, so a backend change that
 * breaks a contract is a red squiggle here rather than a runtime surprise at hour 30.
 */

import type {
  AgentGraph,
  Approval,
  ApprovalDecision,
  Conversation,
  ConversationMessage,
  EgressEvent,
  GraphDelegation,
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

  /* --------------------------------------------------------- Conversations */

  /** `graphId` seeds the conversation so its first message EDITS that graph. */
  createConversation: (graphId?: string) =>
    request<{ conversation: Conversation }>('/conversations', {
      method: 'POST',
      body: JSON.stringify({ graphId }),
    }),

  conversation: (id: string) =>
    request<{ conversation: Conversation; graph: AgentGraph | null }>('/conversations/' + id),

  /**
   * ONE endpoint for both building and editing. The first turn creates a graph;
   * a later turn modifies the same document and bumps its version.
   */
  sendMessage: (id: string, text: string) =>
    request<{
      conversation: Conversation;
      message: ConversationMessage;
      graph: AgentGraph;
      delegation: GraphDelegation;
    }>('/conversations/' + id + '/messages', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  /** Launch a run of a graph. The run snapshots the graph as it is right now. */
  runGraph: (graphId: string, variables: Record<string, unknown> = {}) =>
    request<{ run: Run }>('/runs', {
      method: 'POST',
      body: JSON.stringify({ kind: 'graph', input: { graphId, variables } }),
    }),

  listRuns: (filter: { graphId?: string; kind?: string; status?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (filter.graphId) params.set('graphId', filter.graphId);
    if (filter.kind) params.set('kind', filter.kind);
    if (filter.status) params.set('status', filter.status);
    if (filter.limit) params.set('limit', String(filter.limit));
    const qs = params.toString();
    return request<{ runs: Run[] }>('/runs' + (qs ? '?' + qs : ''));
  },

  createRun: (kind: string, input: unknown) =>
    request<{ run: Run }>('/runs', { method: 'POST', body: JSON.stringify({ kind, input }) }),

  getRun: (id: string) => request<RunDetail>('/runs/' + id),

  cancelRun: (id: string) => request<{ run: Run }>('/runs/' + id + '/cancel', { method: 'POST' }),

  /**
   * Pause is cooperative: this resolves once the server has accepted the
   * request, and the run reports status 'paused' over SSE when it actually
   * reaches a step boundary. Do not render "paused" off this response.
   */
  pauseRun: (id: string) => request<{ run: Run }>('/runs/' + id + '/pause', { method: 'POST' }),

  resumeRun: (id: string) => request<{ run: Run }>('/runs/' + id + '/resume', { method: 'POST' }),

  /** "Save as a new task": fork the graph THIS run executed into a new document. */
  saveRunAsGraph: (id: string) =>
    request<{ graph: AgentGraph }>('/runs/' + id + '/save-as-graph', { method: 'POST' }),

  decide: (approvalId: string, decision: ApprovalDecision) =>
    request<{ approval: Approval }>('/approvals/' + approvalId + '/decide', {
      method: 'POST',
      body: JSON.stringify(decision),
    }),
};
