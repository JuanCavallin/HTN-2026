import type { AgentGraph, RunView, StepStatus, ScheduleDecision } from '@htn/shared';

export type Scenario = 'support' | 'trip';

export type TraceNode = {
  id: string;
  label: string;
  kind: string;
  status: StepStatus;
  route: string;
  detail: string;
  position: { x: number; y: number };
  tokens?: number;
  costCents?: number;
  durationMs?: number;
  decision?: ScheduleDecision;
  /** In the plan, but no execution has been reported for it yet. Carries no measurements. */
  planned: boolean;
  /** Created by the runtime and never present in the plan — a fan-out child or a delegation. */
  unplanned: boolean;
  /** A route the user changed from the inspector. Preview only; see `canInterveneLive`. */
  revised?: boolean;
};

export type Trace = {
  nodes: TraceNode[];
  edges: { id: string; source: string; target: string; label?: string; planned?: boolean }[];
  tokens?: number;
  costCents?: number;
  elapsedMs: number;
  provenance: 'preview' | 'mock' | 'live' | 'mixed' | 'unknown';
  status: string;
};

/**
 * What the run API actually supports today, read by the UI to decide which controls are
 * live and which are shown disabled with their reason.
 *
 * `runs.service.ts` snapshots the graph document at run start on purpose, so that editing a
 * graph cannot retroactively change what an already-finished run did. A mid-run
 * `PATCH /graphs/:id/nodes/:nodeId` therefore has no effect on the running execution, and the
 * run API exposes no pause or resume route at all. Both are required before a node can be
 * edited mid-run, and a revised node must additionally clear `authorize_action`.
 *
 * The contract for making these true is `docs/contracts/run-intervention.md`. When the
 * endpoints land, flip these flags; no component needs rewriting.
 */
export const RUN_CAPABILITIES = {
  pauseResume: false,
  editRunningNode: false,
} as const;

export const canInterveneLive = RUN_CAPABILITIES.pauseResume && RUN_CAPABILITIES.editRunningNode;

/** Stated on every disabled live-intervention control. Names the missing capability, not a vibe. */
export const LIVE_INTERVENTION_REASON =
  'Editing a running step needs pause and resume, which this backend does not expose. A run executes a snapshot of the graph, so changing it now would not reach the running execution.';

/** Candidate routes offered by the inspector's edit control. Preview only. */
export const ROUTE_OPTIONS = [
  { id: 'local', label: 'Local · private', note: 'Runs on the local endpoint. Nothing leaves.' },
  { id: 'cloud-cheap', label: 'Cloud · cheap', note: 'Lower cost. Public context only.' },
  { id: 'cloud-frontier', label: 'Cloud · frontier', note: 'Strongest model. Highest cost.' },
] as const;
export type RouteOption = (typeof ROUTE_OPTIONS)[number]['id'];
export type RouteOverrides = Partial<Record<string, RouteOption>>;

export function formatCost(cents?: number) {
  return cents === undefined ? '—' : '$' + (cents / 100).toFixed(3);
}

/**
 * Compact token count for dense surfaces like a graph node.
 * Unknown stays unknown — a step that reported nothing renders `—`, never `0`.
 */
export function formatTokens(tokens?: number) {
  if (tokens === undefined) return '—';
  return tokens < 1000 ? String(tokens) : (tokens / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
}

export function formatDuration(ms?: number) {
  if (ms === undefined) return '—';
  return ms < 60000
    ? (ms / 1000).toFixed(1) + 's'
    : Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
}

export function advancePreview(elapsed: number, delta: number, playing: boolean, limit: number) {
  return playing ? Math.min(limit, elapsed + Math.max(0, delta)) : elapsed;
}

const NODE_WIDTH = 210;
const RANK_SEP = 92;
const ROW_STEP = 132;

/**
 * Deterministic layered left-to-right layout.
 *
 * Node order inside a rank follows the order the nodes were supplied, which is plan order
 * first and runtime-created nodes appended after. That ordering is what keeps a *growing*
 * graph stable: adding a node shifts its rank to stay centred, but never reshuffles the
 * nodes already on screen, so the picture reads as growth rather than as a jump.
 */
export function layoutTrace<T extends { id: string }>(
  nodes: T[],
  edges: { source: string; target: string }[],
): Map<string, { x: number; y: number }> {
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const edge of edges) {
      if (!rank.has(edge.source) || !rank.has(edge.target)) continue;
      const next = Math.min(nodes.length, (rank.get(edge.source) ?? 0) + 1);
      if (next > (rank.get(edge.target) ?? 0)) {
        rank.set(edge.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const byRank = new Map<number, string[]>();
  for (const node of nodes) {
    const depth = rank.get(node.id) ?? 0;
    byRank.set(depth, [...(byRank.get(depth) ?? []), node.id]);
  }
  const tallest = Math.max(1, ...[...byRank.values()].map((ids) => ids.length));
  const positions = new Map<string, { x: number; y: number }>();
  for (const [depth, ids] of byRank) {
    ids.forEach((id, index) => {
      positions.set(id, {
        x: depth * (NODE_WIDTH + RANK_SEP),
        y: (index - (ids.length - 1) / 2) * ROW_STEP + ((tallest - 1) / 2) * ROW_STEP,
      });
    });
  }
  return positions;
}

const RANK: Record<StepStatus, number> = {
  skipped: 0,
  succeeded: 1,
  pending: 2,
  running: 3,
  blocked: 4,
  failed: 5,
};
const sumKnown = (values: (number | undefined)[]) => {
  const known = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  return known.length ? known.reduce((sum, value) => sum + value, 0) : undefined;
};

export function buildTrace(view: RunView, graph?: AgentGraph | null, now = Date.now()): Trace {
  // Plan order first, then anything the runtime created that was never in the plan.
  // `ctx.fanOut()` makes child steps at execution time; those nodes are real work and must
  // appear, but they must also be visibly distinguished from planned structure.
  const planned = graph?.nodes ?? [];
  const plannedIds = new Set(planned.map((node) => node.id));
  const runtimeSteps = graph
    ? view.steps.filter((step) => !step.nodeId || !plannedIds.has(step.nodeId))
    : view.steps;
  const runtime = runtimeSteps.map((step) => ({
    id: step.id,
    label: step.label,
    type: step.kind,
  }));
  const sources = [
    ...planned.map((node) => ({ id: node.id, label: node.label, type: node.type })),
    ...runtime,
  ];
  const sourceIds = new Set(sources.map((node) => node.id));

  const plannedEdges = (graph?.edges ?? []).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.sourceHandle,
    planned: true,
  }));
  // A runtime step hangs off its parent step, or off the plan node its parent executed.
  const parentOf = (stepId: string) => {
    const step = view.steps.find((item) => item.id === stepId);
    if (!step?.parentStepId) return undefined;
    const parent = view.steps.find((item) => item.id === step.parentStepId);
    if (!parent) return undefined;
    const viaNode = graph && parent.nodeId && plannedIds.has(parent.nodeId) ? parent.nodeId : null;
    return viaNode ?? parent.id;
  };
  const runtimeEdges = runtimeSteps
    .map((step) => ({ id: step.id + '-parent', source: parentOf(step.id), target: step.id }))
    .filter((edge): edge is { id: string; source: string; target: string } =>
      Boolean(edge.source && sourceIds.has(edge.source)),
    )
    .map((edge) => ({ ...edge, planned: false }));
  const edges = [...plannedEdges, ...runtimeEdges];

  const positions = layoutTrace(sources, edges);
  const nodes = sources.map((node): TraceNode => {
    const steps = view.steps.filter((step) =>
      graph && plannedIds.has(node.id) ? step.nodeId === node.id : step.id === node.id,
    );
    const rows = view.egress.filter((row) => steps.some((step) => step.id === row.stepId));
    const decision = view.scheduleDecisions.findLast((item) =>
      steps.some((step) => step.id === item.stepId),
    );
    const starts = steps.map((step) => Date.parse(step.startedAt ?? '')).filter(Number.isFinite);
    const ends = steps.map((step) => Date.parse(step.endedAt ?? '')).filter(Number.isFinite);
    const status = steps.length
      ? steps.reduce(
          (worst, step) => (RANK[step.status] > RANK[worst] ? step.status : worst),
          'skipped' as StepStatus,
        )
      : 'pending';
    const isPlanned = !steps.length;
    return {
      id: node.id,
      label: node.label,
      kind: node.type,
      status,
      planned: isPlanned,
      unplanned: !plannedIds.has(node.id) && !!graph,
      route: decision
        ? `${decision.privacy} · ${decision.modelTier}`
        : (steps.find((step) => step.providerId)?.providerId ?? 'Not reported'),
      detail:
        steps.find((step) => step.error)?.error?.message ??
        decision?.rule ??
        (steps.length
          ? 'Recorded execution step. Select a routed step to inspect its decision.'
          : 'Planned workflow node. Execution has not been reported.'),
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      // A planned node has no measurements at all — not zeroes.
      tokens: isPlanned
        ? undefined
        : sumKnown(rows.flatMap((row) => [row.tokensIn, row.tokensOut])),
      costCents: isPlanned ? undefined : sumKnown(rows.map((row) => row.estimatedCostCents)),
      durationMs: starts.length
        ? Math.max(
            0,
            (steps.some((step) => step.status === 'running')
              ? now
              : ends.length
                ? Math.max(...ends)
                : Math.min(...starts)) - Math.min(...starts),
          )
        : undefined,
      decision,
    };
  });

  const destinations = view.egress.filter(
    (event) => !event.destination.startsWith('hermes-internal://'),
  );
  const mocked = destinations.filter((event) => event.destination.startsWith('mock://')).length;
  const starts = view.steps.map((step) => Date.parse(step.startedAt ?? '')).filter(Number.isFinite);
  const ends = view.steps.map((step) => Date.parse(step.endedAt ?? '')).filter(Number.isFinite);
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(view.run?.status ?? '');
  return {
    nodes,
    edges,
    tokens: sumKnown(view.egress.flatMap((event) => [event.tokensIn, event.tokensOut])),
    costCents: sumKnown(view.egress.map((event) => event.estimatedCostCents)),
    elapsedMs: starts.length
      ? Math.max(0, (terminal ? Math.max(...ends, ...starts) : now) - Math.min(...starts))
      : 0,
    provenance: !destinations.length
      ? 'unknown'
      : mocked === destinations.length
        ? 'mock'
        : mocked
          ? 'mixed'
          : 'live',
    status: view.run?.status ?? 'pending',
  };
}

export const SCENARIOS = {
  support: {
    title: 'Research high-risk accounts',
    prompt:
      'Research our high-risk accounts, prepare a brief, and draft outreach. Ask me before sending anything.',
    intro:
      'I’ll keep private account data local, research public signals, and bring the outreach draft back for your approval.',
    result:
      'Your account brief is ready for review. The private context and public research have been combined into a draft. Nothing has been sent.',
    notes: [
      'Private account context stays local',
      'Public research uses a lower-cost route',
      'Outreach waits for your approval',
    ],
  },
  trip: {
    title: 'A weekend in Toronto',
    prompt:
      'Plan a 3-day trip to Toronto for two people. Include food, attractions, and a rough budget. Keep it realistic and low effort.',
    intro:
      'I’ll explore places to visit, food, and places to stay in parallel, then bring it together into an easy three-day plan.',
    result:
      'A slower weekend in Toronto. Start downtown and along the waterfront, spend a day around Kensington Market, then leave the final afternoon for the islands.',
    notes: [
      'Day 1 · Downtown & the waterfront',
      'Day 2 · Kensington Market & neighbourhood cafés',
      'Day 3 · Toronto Islands & a relaxed afternoon',
    ],
  },
};

export const PREVIEW_LIMIT = 18000;

type PreviewDefinition = {
  id: string;
  label: string;
  kind: string;
  start: number;
  end: number;
  route: string;
  detail: string;
  tokens: number;
  cost: number;
  /** Set when the step is created by the runtime at this time rather than planned up front. */
  spawnedAt?: number;
  parent: string | null;
};

function previewDefinitions(trip: boolean): PreviewDefinition[] {
  return [
    {
      id: 'route',
      label: 'Route the request',
      kind: 'judge',
      start: 0,
      end: 1800,
      route: 'Jev · decision',
      detail:
        'Illustrative routing decision: narrow the candidate tools and select policy-eligible model routes.',
      tokens: 156,
      cost: 0.08,
      parent: null,
    },
    {
      id: 'context',
      label: trip ? 'Find places to explore' : 'Read account context',
      kind: trip ? 'browse' : 'redact',
      start: 1800,
      end: 6300,
      route: trip ? 'Cloud · cheap' : 'Local · private',
      detail: trip
        ? 'Illustrative public research branch for neighbourhoods and attractions.'
        : 'Illustrative privacy path. Synthetic account data is handled locally.',
      tokens: 480,
      cost: trip ? 0.19 : 0,
      parent: 'route',
    },
    {
      id: 'research',
      label: trip ? 'Discover food spots' : 'Research public signals',
      kind: 'browse',
      start: 1800,
      end: 8900,
      route: 'Hermes · cloud',
      detail:
        'Illustrative delegated research using public information only. Internal harness steps are not fully observable.',
      tokens: 860,
      cost: 0.48,
      parent: 'route',
    },
    {
      id: 'compare',
      label: trip ? 'Compare places to stay' : 'Assess account risk',
      kind: 'decide',
      start: 1800,
      end: 11500,
      route: 'Cloud · cheap',
      detail:
        'Illustrative bounded analysis branch. No actual external request is made in this preview.',
      tokens: 632,
      cost: 0.26,
      parent: 'route',
    },
    {
      // Never in the plan. The runtime fans this worker out once the research branch is under
      // way, which is exactly what `ctx.fanOut()` does on a real run.
      id: 'fanout',
      label: trip ? 'Check a second neighbourhood' : 'Check a second filing source',
      kind: 'swarm',
      start: 5200,
      end: 10400,
      spawnedAt: 5200,
      route: 'Hermes · worker',
      detail:
        'Illustrative runtime-created worker. It was never in the plan — the executing step fanned it out.',
      tokens: 344,
      cost: 0.17,
      parent: 'research',
    },
    {
      id: 'synthesis',
      label: trip ? 'Build your itinerary' : 'Prepare account brief',
      kind: 'agent_task',
      start: 11500,
      end: 16500,
      route: 'Hermes · synthesis',
      detail: 'Illustrative synthesis joins the completed branches into one reviewable result.',
      tokens: 1130,
      cost: 0.82,
      parent: 'compare',
    },
    {
      id: 'finish',
      label: trip ? 'Ready for your trip' : 'Approve outreach',
      kind: trip ? 'result' : 'approval',
      start: 16500,
      end: 18000,
      route: trip ? 'Result' : 'Human approval',
      detail: trip
        ? 'Sample itinerary, not live travel research or verified prices.'
        : 'Preview gate only. Approving this example does not send a message.',
      tokens: 0,
      cost: 0,
      parent: 'synthesis',
    },
  ];
}

const PREVIEW_EDGES = [
  ['route', 'context'],
  ['route', 'research'],
  ['route', 'compare'],
  ['research', 'fanout'],
  ['context', 'synthesis'],
  ['research', 'synthesis'],
  ['compare', 'synthesis'],
  ['fanout', 'synthesis'],
  ['synthesis', 'finish'],
];

export function previewTrace(
  scenario: Scenario,
  elapsed: number,
  approval?: 'approved' | 'rejected',
  overrides: RouteOverrides = {},
): Trace {
  const trip = scenario === 'trip';
  const definitions = previewDefinitions(trip);
  // A runtime-created node does not exist on the canvas before the runtime creates it.
  const present = definitions.filter(
    (item) => item.spawnedAt === undefined || elapsed >= item.spawnedAt,
  );
  const presentIds = new Set(present.map((item) => item.id));
  const edges = PREVIEW_EDGES.filter(
    ([source, target]) => presentIds.has(source!) && presentIds.has(target!),
  ).map(([source, target]) => {
    const target_ = definitions.find((item) => item.id === target);
    return {
      id: source + '-' + target,
      source: source!,
      target: target!,
      planned: target_?.spawnedAt === undefined,
    };
  });
  const positions = layoutTrace(present, edges);

  const nodes: TraceNode[] = present.map((item) => {
    let status: StepStatus =
      elapsed < item.start ? 'pending' : elapsed < item.end ? 'running' : 'succeeded';
    if (item.id === 'finish' && !trip && elapsed >= PREVIEW_LIMIT)
      status =
        approval === 'approved' ? 'succeeded' : approval === 'rejected' ? 'skipped' : 'blocked';
    const started = elapsed >= item.start;
    const completed = elapsed >= item.end;
    const override = overrides[item.id];
    const chosen = ROUTE_OPTIONS.find((option) => option.id === override);
    return {
      id: item.id,
      label: item.label,
      kind: item.kind,
      status,
      planned: !started,
      unplanned: item.spawnedAt !== undefined,
      revised: !!chosen,
      route: chosen?.label ?? item.route,
      detail: chosen
        ? `Route changed in this preview to ${chosen.label}. ${chosen.note} On a live run this edit would be re-authorized before execution resumed.`
        : item.detail,
      position: positions.get(item.id) ?? { x: 0, y: 0 },
      // Nothing is reported for a step that has not started. `—`, never `0`.
      tokens: completed ? item.tokens : undefined,
      costCents: completed ? item.cost : undefined,
      durationMs: started ? Math.max(0, Math.min(elapsed, item.end) - item.start) : undefined,
    };
  });

  return {
    nodes,
    edges,
    tokens: sumKnown(nodes.map((node) => node.tokens)),
    costCents: sumKnown(nodes.map((node) => node.costCents)),
    elapsedMs: elapsed,
    provenance: 'preview',
    status:
      elapsed < PREVIEW_LIMIT
        ? 'running'
        : trip || approval === 'approved'
          ? 'succeeded'
          : approval === 'rejected'
            ? 'cancelled'
            : 'awaiting_approval',
  };
}
