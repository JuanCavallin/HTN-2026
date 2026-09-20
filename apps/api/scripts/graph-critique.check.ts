/**
 * Unit checks for buildGraphCritique (packages/shared/src/analytics.ts) and the
 * assertion-stripping safety helper (services/optimization.service.ts).
 *
 * No network, no store, no running API -- synthetic runs/steps/egress only.
 *
 *   pnpm --filter @htn/api check:graph-critique
 */

import assert from 'node:assert/strict';
import {
  buildGraphCritique,
  type AgentGraph,
  type EgressEvent,
  type Run,
  type Step,
} from '@htn/shared';
import { stripAddedAssertions } from '../src/services/optimization.service.js';

const at = new Date().toISOString();
let checks = 0;

function check(label: string, condition: boolean, detail = ''): void {
  checks += 1;
  assert.ok(condition, label + (detail ? ' -> ' + detail : ''));
  console.log('  [PASS] ' + label);
}

function makeGraph(overrides: Partial<AgentGraph> = {}): AgentGraph {
  return {
    id: 'g1',
    name: 'Test graph',
    nodes: [
      {
        id: 'n1',
        type: 'tool',
        label: 'Call a tool',
        position: { x: 0, y: 0 },
        config: { tool: 'sheets.append', args: {} },
      },
    ],
    edges: [],
    version: 1,
    createdAt: at,
    updatedAt: at,
    assertions: [
      { id: 'a1', description: 'Verdict is correct', path: 'nodes.n1.verdict', expected: 'ok' },
    ],
    ...overrides,
  };
}

function makeRun(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    kind: 'graph',
    title: 'Run ' + id,
    status: 'succeeded',
    input: { graphId: 'g1' },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function makeStep(runId: string, overrides: Partial<Step> = {}): Step {
  return {
    id: 'step_' + runId + '_' + (overrides.nodeId ?? 'n1'),
    runId,
    parentStepId: null,
    seq: 0,
    nodeId: 'n1',
    kind: 'tool',
    label: 'Call a tool',
    status: 'succeeded',
    startedAt: at,
    endedAt: at,
    ...overrides,
  };
}

function makeEgress(runId: string, stepId: string, overrides: Partial<EgressEvent> = {}): EgressEvent {
  return {
    id: 'egr_' + stepId,
    runId,
    stepId,
    at,
    providerId: 'anthropic',
    op: 'complete',
    destination: 'mock://anthropic',
    dataSpans: [],
    policyRule: 'test',
    decision: 'allowed',
    latencyMs: 100,
    tokensIn: 10,
    tokensOut: 10,
    estimatedCostCents: 1,
    ...overrides,
  };
}

console.log('buildGraphCritique checks\n');

console.log('1. lowConfidence is true under 3 runs, false at 3+');
{
  const graph = makeGraph();
  const runs = [makeRun('r1'), makeRun('r2')];
  const stepsByRun = new Map([
    ['r1', [makeStep('r1')]],
    ['r2', [makeStep('r2')]],
  ]);

  const under = buildGraphCritique({ graph, runs, stepsByRun });
  check('2 runs -> lowConfidence', under.lowConfidence === true);
  check('runsAnalyzed reflects the runs given', under.runsAnalyzed === 2);

  const threeRuns = [...runs, makeRun('r3')];
  stepsByRun.set('r3', [makeStep('r3')]);
  const atThree = buildGraphCritique({ graph, runs: threeRuns, stepsByRun });
  check('3 runs -> NOT lowConfidence', atThree.lowConfidence === false);
}

console.log('\n2. An assertion failure is counted, a passing one is not reported');
{
  const graph = makeGraph();
  const passingStep = makeStep('r1', { output: { verdict: 'ok' } });
  const failingStep = makeStep('r2', { output: { verdict: 'wrong' } });
  const runs = [makeRun('r1'), makeRun('r2')];
  const stepsByRun = { r1: [passingStep], r2: [failingStep] };

  const critique = buildGraphCritique({ graph, runs, stepsByRun });
  check('one assertion is reported as a failure', critique.assertionFailures.length === 1);
  check(
    'failure tally is 1 failed of 2 total',
    critique.assertionFailures[0]?.passed === 1 && critique.assertionFailures[0]?.total === 2,
  );

  const allPassing = buildGraphCritique({
    graph,
    runs,
    stepsByRun: { r1: [passingStep], r2: [makeStep('r2', { output: { verdict: 'ok' } })] },
  });
  check('no failures reported when every run passes', allPassing.assertionFailures.length === 0);
}

console.log('\n3. A node that spikes above its own median is flagged as a cost outlier');
{
  const graph = makeGraph();
  const runs = [makeRun('r1'), makeRun('r2'), makeRun('r3')];
  const stepsByRun = {
    r1: [makeStep('r1')],
    r2: [makeStep('r2')],
    r3: [makeStep('r3')],
  };
  const egressByRun = {
    r1: [makeEgress('r1', 'step_r1_n1', { estimatedCostCents: 2 })],
    r2: [makeEgress('r2', 'step_r2_n1', { estimatedCostCents: 2 })],
    // 10x the median of the other two, well above the absolute floor too.
    r3: [makeEgress('r3', 'step_r3_n1', { estimatedCostCents: 20 })],
  };

  const critique = buildGraphCritique({ graph, runs, stepsByRun, egressByRun });
  check('exactly one cost outlier flagged', critique.costOutliers.length === 1);
  check('the outlier is the spiking run', critique.costOutliers[0]?.runId === 'r3');
  check('a node inside the median is not flagged as a cost outlier', critique.latencyOutliers.length === 0);
}

console.log('\n4. Baseline comparison is present when baseline runs are given, absent otherwise');
{
  const graph = makeGraph();
  const runs = [makeRun('r1'), makeRun('r2'), makeRun('r3')];
  const stepsByRun = {
    r1: [makeStep('r1')],
    r2: [makeStep('r2')],
    r3: [makeStep('r3')],
  };
  const egressByRun = {
    r1: [makeEgress('r1', 'step_r1_n1', { tokensIn: 100, tokensOut: 50, estimatedCostCents: 3 })],
    r2: [makeEgress('r2', 'step_r2_n1', { tokensIn: 100, tokensOut: 50, estimatedCostCents: 3 })],
    r3: [makeEgress('r3', 'step_r3_n1', { tokensIn: 100, tokensOut: 50, estimatedCostCents: 3 })],
  };

  const noBaseline = buildGraphCritique({ graph, runs, stepsByRun, egressByRun });
  check('no baselineComparison when no baseline runs are given', noBaseline.baselineComparison === undefined);

  const baselineRun = makeRun('b1', { kind: 'baseline', input: { graphId: 'g1' } });
  const baselineStep = makeStep('b1', { kind: 'decide' });
  const withBaseline = buildGraphCritique({
    graph,
    runs,
    stepsByRun,
    egressByRun,
    baselineRuns: [baselineRun],
    baselineStepsByRun: { b1: [baselineStep] },
    baselineEgressByRun: {
      b1: [makeEgress('b1', baselineStep.id, { tokensIn: 500, tokensOut: 300, estimatedCostCents: 40 })],
    },
  });
  check('baselineComparison present when baseline runs are given', Boolean(withBaseline.baselineComparison));
  check(
    'baseline medians reflect the baseline run, not the graph runs',
    withBaseline.baselineComparison?.medianCostCents.baseline === 40 &&
      withBaseline.baselineComparison?.medianCostCents.graph === 3,
  );
}

console.log('\nstripAddedAssertions checks\n');

console.log('5. An assertion the candidate adds is dropped and reported, one already on the source is kept');
{
  const source = makeGraph({
    assertions: [{ id: 'a1', description: 'Verdict is correct', path: 'nodes.n1.verdict', expected: 'ok' }],
  });
  const candidate = makeGraph({
    assertions: [
      { id: 'a1', description: 'Verdict is correct', path: 'nodes.n1.verdict', expected: 'ok' },
      { id: 'a2', description: 'New unearned criterion', path: 'nodes.n1.extra', expected: 'yes' },
    ],
  });

  const { graph, suggestedAssertions } = stripAddedAssertions(candidate, source);
  check('the pre-existing assertion survives', graph.assertions?.length === 1 && graph.assertions[0]?.id === 'a1');
  check('the new assertion is dropped from the saved graph', !graph.assertions?.some((a) => a.id === 'a2'));
  check(
    'the dropped assertion is reported back for a human to review',
    suggestedAssertions.length === 1 && suggestedAssertions[0]?.id === 'a2',
  );
}

console.log('\n6. A candidate with no assertions added strips nothing');
{
  const source = makeGraph();
  const candidate = makeGraph();
  const { graph, suggestedAssertions } = stripAddedAssertions(candidate, source);
  check('assertions unchanged', graph.assertions?.length === source.assertions?.length);
  check('nothing suggested', suggestedAssertions.length === 0);
}

console.log('\nALL ' + checks + ' CHECK(S) PASSED');
