/**
 * Benchmarks — graph vs baseline across EVERY stored run, not one pair.
 *
 * Compare answers "how did this run do against its baseline"; this page answers
 * "does orchestration actually win, and by how much". All numbers come from
 * GET /api/benchmarks, which reduces stored runs with buildBenchmarkReport in
 * @htn/shared — the same function scripts/benchmark.ts prints from — so the
 * page and the script can never disagree.
 *
 * Read the rules off the page, not just the numbers: success means every graph
 * assertion passed; cost per success is total spend over successes; savings are
 * counted only on pairs where BOTH sides succeeded (the design spec's rule); and
 * a "≥" cost is a lower bound because some call had no known price.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BENCHMARK_ARMS,
  BENCHMARK_ARM_LABELS,
  type ArmStats,
  type BenchmarkArm,
  type BenchmarkReport,
  type PairedSaving,
} from '@htn/shared';
import { api } from '../lib/api';
import { msLabel } from '../lib/format';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';

const pct = (value: number) => Math.round(value * 100) + '%';

function cents(value: number, lowerBound: boolean): string {
  return (
    (lowerBound ? '≥ ' : '') +
    (value >= 100 ? '$' + (value / 100).toFixed(2) : value.toFixed(3) + '¢')
  );
}

/** "41% cheaper" / "12% more expensive", from a 1 - graph/baseline ratio. */
function savingLabel(value: number | null, noun = 'cheaper', opposite = 'more expensive'): string {
  if (value === null) return '—';
  return value >= 0 ? pct(value) + ' ' + noun : pct(-value) + ' ' + opposite;
}

export function Benchmarks() {
  const [includeMock, setIncludeMock] = useState(false);
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setReport(await api.benchmarks(includeMock));
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Could not load benchmarks.');
    } finally {
      setLoading(false);
    }
  }, [includeMock]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Graph vs baseline</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Every workflow run measured against the same task sent to a single frontier call (B0)
            and to one frontier agent with every tool (B1). Success means every assertion passed;
            savings count only on pairs where both sides succeeded.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-2 text-slate-300">
            <input
              type="checkbox"
              checked={includeMock}
              onChange={(event) => setIncludeMock(event.target.checked)}
            />
            Include mock runs
          </label>
          <button
            className="rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-200 hover:border-slate-600"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && <p className="text-sm text-rose-400">{error}</p>}
      {!report && loading && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner />
          Measuring stored runs…
        </div>
      )}
      {report && <ReportView report={report} />}
    </div>
  );
}

function ReportView({ report }: { report: BenchmarkReport }) {
  if (report.graphs.length === 0) {
    return (
      <Card title="No comparisons yet">
        <p className="text-sm text-slate-400">
          Open a workflow in{' '}
          <Link to="/graphs" className="text-sky-300 hover:underline">
            Workflows
          </Link>{' '}
          and choose <strong>Run + compare to baseline</strong> (or <strong>both baselines</strong>
          ). Run it a few times: one pair is an anecdote, five is a measurement.
        </p>
        {report.mockedRunsExcluded > 0 && (
          <p className="mt-2 text-xs text-slate-500">
            {report.mockedRunsExcluded} mocked run(s) are hidden. Their tokens and costs are not
            real; tick “Include mock runs” to see them anyway.
          </p>
        )}
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {report.includeMocked && (
        <p className="text-xs text-amber-300" role="status">
          Mock runs included: token and cost figures below are partly simulated.
        </p>
      )}
      {!report.includeMocked && report.mockedRunsExcluded > 0 && (
        <p className="text-xs text-slate-500">
          {report.mockedRunsExcluded} mocked run(s) excluded.
        </p>
      )}

      <section aria-label="Overall" className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          All workflows
        </h2>
        <KpiRow arms={report.overall} savings={report.overallSavings} />
        <ArmTable arms={report.overall} />
      </section>

      {report.graphs.map((graph) => (
        <Card key={graph.graphId} title={graph.graphName}>
          <div className="space-y-3">
            {!graph.hasAssertions && (
              <p className="text-xs text-amber-300">
                This workflow has no assertions, so “success” only means the run finished — it does
                not mean the answer was right. Add assertions to make this comparison count.
              </p>
            )}
            <ArmTable arms={graph.arms} />
            <SavingsLines savings={graph.savings} />
            <Link
              to={'/graphs/' + graph.graphId}
              className="inline-block text-xs text-sky-300 hover:underline"
            >
              Open workflow →
            </Link>
          </div>
        </Card>
      ))}
    </div>
  );
}

function KpiRow({
  arms,
  savings,
}: {
  arms: Partial<Record<BenchmarkArm, ArmStats>>;
  savings: PairedSaving[];
}) {
  const graph = arms.graph;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        label="Graph success rate"
        value={graph ? pct(graph.successRate) : '—'}
        detail={
          graph
            ? graph.successes +
              ' of ' +
              graph.runs +
              ' runs' +
              (['baseline', 'baseline_agent'] as const)
                .filter((arm) => arms[arm])
                .map(
                  (arm) =>
                    ' · ' + (arm === 'baseline' ? 'B0 ' : 'B1 ') + pct(arms[arm]!.successRate),
                )
                .join('')
            : 'No graph runs'
        }
      />
      <Tile
        label="Graph cost per success"
        value={
          graph?.costPerSuccessCents != null
            ? cents(graph.costPerSuccessCents, graph.unpricedCalls > 0)
            : '—'
        }
        detail={(['baseline', 'baseline_agent'] as const)
          .filter((arm) => arms[arm])
          .map(
            (arm) =>
              (arm === 'baseline' ? 'B0 ' : 'B1 ') +
              (arms[arm]!.costPerSuccessCents != null
                ? cents(arms[arm]!.costPerSuccessCents!, arms[arm]!.unpricedCalls > 0)
                : 'no successes'),
          )
          .join(' · ')}
      />
      {savings.map((entry) => (
        <Tile
          key={entry.versus}
          label={'Paired cost vs ' + (entry.versus === 'baseline' ? 'B0' : 'B1')}
          value={savingLabel(entry.medianCostSaving)}
          detail={
            (entry.costSavingCi
              ? '95% CI ' + savingRange(entry.costSavingCi) + ' · '
              : entry.bothSucceeded > 0
                ? 'need 3+ pairs for an interval · '
                : '') +
            entry.bothSucceeded +
            ' of ' +
            entry.pairs +
            ' pairs both succeeded'
          }
        />
      ))}
    </div>
  );
}

function savingRange([low, high]: [number, number]): string {
  return Math.round(low * 100) + '% to ' + Math.round(high * 100) + '%';
}

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-100">{value}</div>
      <div className="mt-1 text-xs text-slate-400">{detail}</div>
    </div>
  );
}

function ArmTable({ arms }: { arms: Partial<Record<BenchmarkArm, ArmStats>> }) {
  const rows = BENCHMARK_ARMS.map((arm) => arms[arm]).filter((row): row is ArmStats => !!row);
  const maxCps = Math.max(0, ...rows.map((row) => row.costPerSuccessCents ?? 0));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-slate-500">
            <th className="py-1.5 pr-3 font-medium">Arm</th>
            <th className="py-1.5 pr-3 font-medium">Runs</th>
            <th className="py-1.5 pr-3 font-medium">Success</th>
            <th className="w-56 py-1.5 pr-3 font-medium">Cost per success</th>
            <th className="py-1.5 pr-3 font-medium">Median cost</th>
            <th className="py-1.5 pr-3 font-medium">Median tokens</th>
            <th className="py-1.5 pr-3 font-medium">Active time p50 / p95</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const lowerBound = row.unpricedCalls > 0;
            const width =
              row.costPerSuccessCents != null && maxCps > 0
                ? Math.max(2, (row.costPerSuccessCents / maxCps) * 100)
                : 0;
            return (
              <tr key={row.arm} className="border-t border-slate-800 text-slate-200">
                <td className="py-2 pr-3">{BENCHMARK_ARM_LABELS[row.arm]}</td>
                <td className="py-2 pr-3">{row.runs}</td>
                <td className="py-2 pr-3">
                  {pct(row.successRate)}{' '}
                  <span className="text-xs text-slate-500">
                    ({row.successes}/{row.runs})
                  </span>
                </td>
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0">
                      {row.costPerSuccessCents != null
                        ? cents(row.costPerSuccessCents, lowerBound)
                        : 'no successes'}
                    </span>
                    {width > 0 && (
                      <span
                        className="h-2 flex-1 rounded-r bg-transparent"
                        title={
                          BENCHMARK_ARM_LABELS[row.arm] +
                          ': ' +
                          cents(row.costPerSuccessCents!, lowerBound) +
                          ' per successful run'
                        }
                      >
                        <span
                          className={
                            'block h-2 rounded-r ' +
                            (row.arm === 'graph' ? 'bg-sky-400' : 'bg-slate-600')
                          }
                          style={{ width: width + '%' }}
                        />
                      </span>
                    )}
                  </div>
                  {lowerBound && (
                    <div className="text-xs text-slate-500">
                      {row.unpricedCalls} unpriced call{row.unpricedCalls === 1 ? '' : 's'} — lower
                      bound
                    </div>
                  )}
                </td>
                <td className="py-2 pr-3">{cents(row.medianCostCents, lowerBound)}</td>
                <td className="py-2 pr-3">{Math.round(row.medianTokens).toLocaleString()}</td>
                <td className="py-2 pr-3">
                  {msLabel(row.medianWallMs)} / {msLabel(row.p95WallMs)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SavingsLines({ savings }: { savings: PairedSaving[] }) {
  if (savings.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs text-slate-400">
      {savings.map((entry) => (
        <li key={entry.versus}>
          <span className="text-slate-300">vs {entry.versus === 'baseline' ? 'B0' : 'B1'}:</span>{' '}
          {entry.bothSucceeded > 0 ? (
            <>
              cost {savingLabel(entry.medianCostSaving)}
              {entry.costSavingCi ? ' (95% CI ' + savingRange(entry.costSavingCi) + ')' : ''},
              tokens {savingLabel(entry.medianTokenSaving, 'fewer', 'more')}, active time{' '}
              {savingLabel(entry.medianWallSaving, 'faster', 'slower')} — median over{' '}
              {entry.bothSucceeded} pair(s) where both succeeded.
            </>
          ) : (
            <>no pair where both succeeded yet.</>
          )}{' '}
          Graph-only wins: {entry.graphOnlyWins}; baseline-only wins: {entry.baselineOnlyWins}.
        </li>
      ))}
    </ul>
  );
}
