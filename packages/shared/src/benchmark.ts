/**
 * Graph vs baseline benchmark — the ONE implementation of the comparison math.
 *
 * Pure and in @htn/shared so the API endpoint (GET /api/benchmarks), the
 * Benchmarks page and the repeat-run script (scripts/benchmark.ts) cannot
 * drift: they all reduce the same runs with this file.
 *
 * Three arms per graph:
 *   graph           the orchestrated run
 *   baseline        B0 — one frontier call, no tools
 *   baseline_agent  B1 — one agent, frontier model, every tool, no Jev
 *
 * The rules, each one deliberate:
 *   - SUCCESS is "run succeeded AND every graph assertion passed". A run that
 *     finished but answered wrong is a failure. With no assertions, success
 *     falls back to "succeeded" and the result says so (`hasAssertions`).
 *   - The headline cost metric is COST PER SUCCESS (total spend / successes).
 *     Per-run cost alone rewards an arm that is cheap because it gives up.
 *   - SAVINGS COUNT ONLY WHEN BOTH SIDES SUCCEED (the design spec's evaluation
 *     rule): runs are paired, and only pairs where both passed contribute.
 *   - Costs are lower bounds whenever any call was unpriced; that is carried
 *     through rather than hidden.
 *   - Mocked runs (any mock:// egress) are separated; their numbers are not
 *     real and are excluded unless the caller explicitly asks.
 */

import { evaluateAssertions, rollup, type AssertionResult, type RollupInput } from './analytics.js';
import type { Run } from './domain.js';
import type { AgentGraph, GraphAssertion } from './schemas/graph.js';

export const BENCHMARK_ARMS = ['graph', 'baseline', 'baseline_agent'] as const;
export type BenchmarkArm = (typeof BENCHMARK_ARMS)[number];

export const BENCHMARK_ARM_LABELS: Record<BenchmarkArm, string> = {
  graph: 'Graph (orchestrated)',
  baseline: 'B0 · one call, no tools',
  baseline_agent: 'B1 · one agent, all tools',
};

export function isBenchmarkArm(kind: string): kind is BenchmarkArm {
  return (BENCHMARK_ARMS as readonly string[]).includes(kind);
}

/**
 * Check graph assertions against a run that has no per-node steps (a baseline):
 * its flat `result` is matched by each assertion path's LAST field name, e.g.
 * "nodes.verdict.choice" -> result.choice. Baselines are asked to reply with
 * exactly those field names (see baselineTask.ts), never the expected values.
 */
export function evaluateAssertionsAgainstResult(
  assertions: GraphAssertion[],
  result: unknown,
): AssertionResult[] {
  return assertions.map((assertion) => {
    const field = assertion.path.split('.').at(-1) ?? '';
    const value =
      result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>)[field]
        : undefined;
    const actual = value === undefined || value === null ? null : String(value);
    return {
      id: assertion.id,
      description: assertion.description,
      expected: assertion.expected,
      actual,
      passed: actual !== null && actual === assertion.expected,
    };
  });
}

/** The assertions a run is judged by: a graph's own snapshot, or a baseline's copy. */
export function assertionsForRun(run: Run): GraphAssertion[] {
  const input = (run.input ?? {}) as {
    graphSnapshot?: AgentGraph;
    assertions?: GraphAssertion[];
  };
  return input.graphSnapshot?.assertions ?? input.assertions ?? [];
}

export function pairIdOf(run: Run): string | undefined {
  const pairId = (run.input as { pairId?: unknown } | null)?.pairId;
  return typeof pairId === 'string' ? pairId : undefined;
}

export interface BenchmarkSample {
  runId: string;
  arm: BenchmarkArm;
  graphId: string;
  pairId?: string;
  createdAt: string;
  status: string;
  hasAssertions: boolean;
  assertionsPassed: number;
  assertionsTotal: number;
  success: boolean;
  costCents: number;
  unpricedCalls: number;
  tokens: number;
  llmCalls: number;
  wallMs: number;
  humanWaitMs: number;
  mocked: boolean;
}

export function benchmarkSample(input: RollupInput): BenchmarkSample | null {
  const { run } = input;
  if (!isBenchmarkArm(run.kind) || !run.graphId) return null;
  const analytics = rollup(input);
  const assertions = assertionsForRun(run);
  const results =
    run.kind === 'graph'
      ? evaluateAssertions(assertions, input.steps)
      : evaluateAssertionsAgainstResult(assertions, run.result);
  const passed = results.filter((result) => result.passed).length;
  return {
    runId: run.id,
    arm: run.kind,
    graphId: run.graphId,
    pairId: pairIdOf(run),
    createdAt: run.createdAt,
    status: run.status,
    hasAssertions: assertions.length > 0,
    assertionsPassed: passed,
    assertionsTotal: assertions.length,
    success: run.status === 'succeeded' && passed === assertions.length,
    costCents: analytics.totals.estimatedCostCents,
    unpricedCalls: analytics.totals.unpricedCalls,
    tokens: analytics.totals.tokensIn + analytics.totals.tokensOut,
    llmCalls: analytics.totals.llmCalls,
    wallMs: analytics.totals.wallMs,
    humanWaitMs: analytics.totals.humanWaitMs,
    mocked: analytics.totals.egress.mocked > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Statistics                                                                 */
/* -------------------------------------------------------------------------- */

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
}

const median = (values: number[]) => quantile(values, 0.5);

/**
 * 95% percentile-bootstrap interval for the median. Seeded, so the page, the
 * endpoint and the script print the SAME interval for the same runs.
 */
function bootstrapMedianCi(values: number[], resamples = 1000): [number, number] | null {
  if (values.length < 3) return null;
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const medians: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    const sample = values.map(() => values[Math.floor(random() * values.length)]!);
    medians.push(median(sample));
  }
  return [quantile(medians, 0.025), quantile(medians, 0.975)];
}

export interface ArmStats {
  arm: BenchmarkArm;
  runs: number;
  successes: number;
  successRate: number;
  totalCostCents: number;
  /** Total spend / successes. null when nothing succeeded (cost per success is unbounded). */
  costPerSuccessCents: number | null;
  medianCostCents: number;
  medianTokens: number;
  medianWallMs: number;
  p95WallMs: number;
  /** Any unpriced call in any run makes every cost figure for this arm a lower bound. */
  unpricedCalls: number;
}

export interface PairedSaving {
  /** The baseline arm the graph is compared against. */
  versus: Exclude<BenchmarkArm, 'graph'>;
  /** Pairs found at all, and the subset where BOTH runs succeeded. */
  pairs: number;
  bothSucceeded: number;
  /** Median of per-pair (1 - graph / baseline). 0.4 = graph 40% cheaper. Both-succeeded pairs only. */
  medianCostSaving: number | null;
  costSavingCi: [number, number] | null;
  medianTokenSaving: number | null;
  medianWallSaving: number | null;
  /** Pairs where the graph succeeded and this baseline did not, and vice versa. */
  graphOnlyWins: number;
  baselineOnlyWins: number;
}

export interface GraphBenchmark {
  graphId: string;
  graphName: string;
  hasAssertions: boolean;
  arms: Partial<Record<BenchmarkArm, ArmStats>>;
  savings: PairedSaving[];
}

export interface BenchmarkReport {
  includeMocked: boolean;
  mockedRunsExcluded: number;
  graphs: GraphBenchmark[];
  /** Every graph's runs pooled together, per arm. */
  overall: Partial<Record<BenchmarkArm, ArmStats>>;
  overallSavings: PairedSaving[];
}

export function armStats(arm: BenchmarkArm, samples: BenchmarkSample[]): ArmStats {
  const successes = samples.filter((sample) => sample.success).length;
  const totalCostCents = samples.reduce((sum, sample) => sum + sample.costCents, 0);
  return {
    arm,
    runs: samples.length,
    successes,
    successRate: samples.length > 0 ? successes / samples.length : 0,
    totalCostCents,
    costPerSuccessCents: successes > 0 ? totalCostCents / successes : null,
    medianCostCents: median(samples.map((sample) => sample.costCents)),
    medianTokens: median(samples.map((sample) => sample.tokens)),
    medianWallMs: median(samples.map((sample) => sample.wallMs)),
    p95WallMs: quantile(
      samples.map((sample) => sample.wallMs),
      0.95,
    ),
    unpricedCalls: samples.reduce((sum, sample) => sum + sample.unpricedCalls, 0),
  };
}

/**
 * Pair each graph run with ONE run of the other arm on the same graph:
 * the same `pairId` when both carry one (launched together), otherwise the
 * nearest-in-time unused run. Each run is used in at most one pair.
 */
export function pairRuns(
  graphRuns: BenchmarkSample[],
  others: BenchmarkSample[],
): [BenchmarkSample, BenchmarkSample][] {
  const used = new Set<string>();
  const pairs: [BenchmarkSample, BenchmarkSample][] = [];
  const time = (sample: BenchmarkSample) => new Date(sample.createdAt).getTime();
  for (const graphRun of graphRuns) {
    const candidates = others.filter(
      (other) => other.graphId === graphRun.graphId && !used.has(other.runId),
    );
    const exact = graphRun.pairId
      ? candidates.find((other) => other.pairId === graphRun.pairId)
      : undefined;
    const nearest = exact
      ? exact
      : candidates
          .filter((other) => !other.pairId || !graphRun.pairId)
          .sort(
            (a, b) => Math.abs(time(a) - time(graphRun)) - Math.abs(time(b) - time(graphRun)),
          )[0];
    if (!nearest) continue;
    used.add(nearest.runId);
    pairs.push([graphRun, nearest]);
  }
  return pairs;
}

function saving(graph: number, baseline: number): number | null {
  return baseline > 0 ? 1 - graph / baseline : null;
}

export function pairedSaving(
  versus: Exclude<BenchmarkArm, 'graph'>,
  graphRuns: BenchmarkSample[],
  baselineRuns: BenchmarkSample[],
): PairedSaving {
  const pairs = pairRuns(graphRuns, baselineRuns);
  const both = pairs.filter(([graph, baseline]) => graph.success && baseline.success);
  const values = (pick: (sample: BenchmarkSample) => number) =>
    both
      .map(([graph, baseline]) => saving(pick(graph), pick(baseline)))
      .filter((value): value is number => value !== null);
  const cost = values((sample) => sample.costCents);
  const tokens = values((sample) => sample.tokens);
  const wall = values((sample) => sample.wallMs);
  return {
    versus,
    pairs: pairs.length,
    bothSucceeded: both.length,
    medianCostSaving: cost.length > 0 ? median(cost) : null,
    costSavingCi: bootstrapMedianCi(cost),
    medianTokenSaving: tokens.length > 0 ? median(tokens) : null,
    medianWallSaving: wall.length > 0 ? median(wall) : null,
    graphOnlyWins: pairs.filter(([graph, baseline]) => graph.success && !baseline.success).length,
    baselineOnlyWins: pairs.filter(([graph, baseline]) => !graph.success && baseline.success)
      .length,
  };
}

function statsByArm(samples: BenchmarkSample[]): Partial<Record<BenchmarkArm, ArmStats>> {
  const arms: Partial<Record<BenchmarkArm, ArmStats>> = {};
  for (const arm of BENCHMARK_ARMS) {
    const mine = samples.filter((sample) => sample.arm === arm);
    if (mine.length > 0) arms[arm] = armStats(arm, mine);
  }
  return arms;
}

function savingsFor(samples: BenchmarkSample[]): PairedSaving[] {
  const graphRuns = samples.filter((sample) => sample.arm === 'graph');
  return (['baseline', 'baseline_agent'] as const)
    .map((versus) =>
      pairedSaving(
        versus,
        graphRuns,
        samples.filter((sample) => sample.arm === versus),
      ),
    )
    .filter((entry) => entry.pairs > 0);
}

/** Reduce terminal samples into the per-graph and pooled report. */
export function buildBenchmarkReport(
  allSamples: BenchmarkSample[],
  graphNames: Record<string, string>,
  options: { includeMocked?: boolean } = {},
): BenchmarkReport {
  const includeMocked = options.includeMocked ?? false;
  const samples = includeMocked ? allSamples : allSamples.filter((sample) => !sample.mocked);
  const graphIds = [...new Set(samples.map((sample) => sample.graphId))];
  const graphs = graphIds
    .map((graphId) => {
      const mine = samples.filter((sample) => sample.graphId === graphId);
      return {
        graphId,
        graphName: graphNames[graphId] ?? graphId,
        hasAssertions: mine.some((sample) => sample.hasAssertions),
        arms: statsByArm(mine),
        savings: savingsFor(mine),
      };
    })
    // Only graphs with something to compare against are a benchmark.
    .filter((graph) => Object.keys(graph.arms).length > 1)
    .sort((a, b) => a.graphName.localeCompare(b.graphName));
  const compared = samples.filter((sample) =>
    graphs.some((graph) => graph.graphId === sample.graphId),
  );
  return {
    includeMocked,
    mockedRunsExcluded: includeMocked ? 0 : allSamples.filter((sample) => sample.mocked).length,
    graphs,
    overall: statsByArm(compared),
    overallSavings: savingsFor(compared),
  };
}
