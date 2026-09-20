/**
 * "At a glance" bars for the Compare page: one small chart per metric, two bars
 * each. Lower is better on all four, so the winner is the shorter bar and the
 * delta chip is green when B beat A. Loaded lazily (recharts is the heaviest
 * dependency in the app) -- see the React.lazy in Compare.tsx.
 */

import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, XAxis } from 'recharts';
import type { RunAnalytics } from '@htn/shared';
import { msLabel } from '../../lib/format';

export interface CompareSide {
  label: string;
  analytics: RunAnalytics;
}

interface Metric {
  key: string;
  title: string;
  pick: (a: RunAnalytics) => number;
  format: (v: number) => string;
}

const METRICS: Metric[] = [
  { key: 'wall', title: 'Wall time', pick: (a) => a.totals.wallMs, format: msLabel },
  {
    key: 'tokens',
    title: 'Tokens',
    pick: (a) => a.totals.tokensIn + a.totals.tokensOut,
    format: (v) => Math.round(v).toLocaleString(),
  },
  {
    key: 'cost',
    title: 'Est. cost',
    pick: (a) => a.totals.estimatedCostCents,
    format: (v) => v.toFixed(4) + '¢',
  },
  {
    key: 'calls',
    title: 'Model calls',
    pick: (a) => a.totals.llmCalls,
    format: (v) => String(Math.round(v)),
  },
];

const COLORS = ['#6ea8fe', '#a78bfa'];

function delta(a: number, b: number): { text: string; better: boolean } | null {
  if (a === 0 && b === 0) return null;
  if (a === 0) return { text: 'new', better: false };
  const pct = ((b - a) / a) * 100;
  if (Math.abs(pct) < 0.5) return { text: 'same', better: true };
  return { text: (pct > 0 ? '+' : '−') + Math.abs(Math.round(pct)) + '%', better: pct < 0 };
}

export default function CompareCharts({ a, b }: { a: CompareSide; b: CompareSide }) {
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
        {[a, b].map((side, index) => (
          <span key={index} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: COLORS[index] }} />
            <span className="font-mono text-slate-500">{index === 0 ? 'A' : 'B'}</span>
            {side.label}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {METRICS.map((metric) => {
          const values = [metric.pick(a.analytics), metric.pick(b.analytics)];
          // Axis names are "A" / "B" (always unique) -- two runs of the same graph
          // version would otherwise share a label and collapse into one bar slot.
          const data = [
            { name: 'A', value: values[0] },
            { name: 'B', value: values[1] },
          ];
          const change = delta(values[0], values[1]);

          return (
            <div
              key={metric.key}
              className="rounded-lg border border-slate-800 bg-slate-950/40 p-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  {metric.title}
                </span>
                {change && (
                  <span
                    className={
                      'rounded-full px-1.5 py-px text-[10px] font-medium ring-1 ring-inset ' +
                      (change.better
                        ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
                        : 'bg-rose-500/15 text-rose-300 ring-rose-500/30')
                    }
                    title={b.label + ' vs ' + a.label}
                  >
                    {change.text}
                  </span>
                )}
              </div>

              <div className="mt-2 h-28">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data} margin={{ top: 16, right: 4, bottom: 0, left: 4 }}>
                    <XAxis
                      dataKey="name"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: '#8b95a8', fontSize: 10 }}
                    />
                    <Bar
                      dataKey="value"
                      radius={[4, 4, 0, 0]}
                      minPointSize={2}
                      isAnimationActive
                      animationDuration={700}
                    >
                      {data.map((_, index) => (
                        <Cell key={index} fill={COLORS[index]} />
                      ))}
                      <LabelList
                        dataKey="value"
                        position="top"
                        formatter={(v: unknown) => metric.format(Number(v))}
                        style={{ fill: '#cfd5e1', fontSize: 10 }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
