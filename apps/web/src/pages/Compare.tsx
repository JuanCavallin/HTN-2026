/**
 * Compare any two runs side by side.
 *
 * Deliberately generic over WHICH two runs -- a graph run against its
 * baseline (the core "structured graph beats one LLM call" argument), or a
 * graph run against the previous run of the SAME graph (did an edit actually
 * help?). Both are the same metrics table; only which two run ids land in
 * the URL differs. See RunDetail.tsx for the two entry points that build
 * this URL: "vs. baseline" and "vs. previous run".
 *
 * All numbers come from GET /runs/:id/analytics (rollup(), already built) --
 * nothing here is computed a second way. Assertions are the one piece that
 * needed new code: evaluateAssertions() (in @htn/shared) checks a graph run's
 * steps against its own graph.assertions; a baseline run has no graph or
 * per-node steps to check the same way, so its side reads straight off its
 * flat `result` object using the SAME expected values, matched by field name.
 */

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  evaluateAssertions,
  type AgentGraph,
  type AssertionResult,
  type GraphAssertion,
  type Run,
  type RunAnalytics,
} from '@htn/shared';
import { api, type RunDetail } from '../lib/api';
import { humanStatus, msLabel, relativeTime, RUN_STATUS_TONE } from '../lib/format';
import { Badge } from '../components/ui/Badge';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';

interface Side {
  run: Run;
  detail: RunDetail;
  analytics: RunAnalytics;
  graph: AgentGraph | null;
  assertions: AssertionResult[];
}

function graphOf(run: Run): AgentGraph | null {
  return (run.input as { graphSnapshot?: AgentGraph }).graphSnapshot ?? null;
}

/** A baseline run has no per-node steps -- check its flat `result` directly,
 *  matching each assertion's expected value by its path's LAST field name
 *  (e.g. "nodes.verdict.choice" -> result.choice). */
function assertionsAgainstResult(assertions: GraphAssertion[], result: unknown): AssertionResult[] {
  return assertions.map((assertion) => {
    const field = assertion.path.split('.').at(-1) ?? '';
    const value =
      result && typeof result === 'object' ? (result as Record<string, unknown>)[field] : undefined;
    const actual = value === undefined ? null : String(value);
    return {
      id: assertion.id,
      description: assertion.description,
      expected: assertion.expected,
      actual,
      passed: actual !== null && actual === assertion.expected,
    };
  });
}

async function loadSide(id: string): Promise<Side> {
  const [detail, analytics] = await Promise.all([api.getRun(id), api.analytics(id)]);
  const graph = graphOf(detail.run);
  return { run: detail.run, detail, analytics, graph, assertions: [] };
}

/** Fill in assertions once both sides are loaded -- a baseline needs the
 *  OTHER side's graph to know what to check itself against. */
function withAssertions(side: Side, other: Side): Side {
  if (side.graph?.assertions) {
    return { ...side, assertions: evaluateAssertions(side.graph.assertions, side.detail.steps) };
  }
  if (other.graph?.assertions && side.run.kind !== 'graph') {
    return {
      ...side,
      assertions: assertionsAgainstResult(other.graph.assertions, side.run.result),
    };
  }
  return side;
}

export function Compare() {
  const [params] = useSearchParams();
  const aId = params.get('a');
  const bId = params.get('b');

  const [sides, setSides] = useState<[Side, Side] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!aId || !bId) return;
    setSides(null);
    setError(null);
    Promise.all([loadSide(aId), loadSide(bId)])
      .then(([a, b]) => setSides([withAssertions(a, b), withAssertions(b, a)]))
      .catch((err) => setError((err as Error).message));
  }, [aId, bId]);

  if (!aId || !bId) {
    return <p className="text-sm text-rose-400">Compare needs two run ids: ?a=...&b=...</p>;
  }
  if (error) return <p className="text-sm text-rose-400">{error}</p>;
  if (!sides) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner />
        Loading both runs…
      </div>
    );
  }

  const [a, b] = sides;
  const sameGraph = a.graph && b.graph && a.graph.id === b.graph.id;

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold text-slate-100">Compare runs</h1>

      <div className="grid grid-cols-[10rem_1fr_1fr] gap-x-4 gap-y-1 text-sm">
        <div />
        <SideHeader side={a} />
        <SideHeader side={b} />

        <Row label="Version" a={versionLabel(a, b, sameGraph)} b={versionLabel(b, a, sameGraph)} />
        <Row
          label="Wall time"
          a={msLabel(a.analytics.totals.wallMs)}
          b={msLabel(b.analytics.totals.wallMs)}
        />
        <Row
          label="Tokens (in/out)"
          a={a.analytics.totals.tokensIn + ' / ' + a.analytics.totals.tokensOut}
          b={b.analytics.totals.tokensIn + ' / ' + b.analytics.totals.tokensOut}
        />
        <Row
          label="Estimated cost"
          a={a.analytics.totals.estimatedCostCents.toFixed(4) + '¢'}
          b={b.analytics.totals.estimatedCostCents.toFixed(4) + '¢'}
        />
        <Row
          label="Model calls"
          a={String(a.analytics.totals.llmCalls)}
          b={String(b.analytics.totals.llmCalls)}
        />
        <Row
          label="Tool reduction"
          a={toolReductionLabel(a.analytics)}
          b={toolReductionLabel(b.analytics)}
        />
        <Row label="Approvals" a={approvalsLabel(a)} b={approvalsLabel(b)} />
        <Row
          label="PII spans pinned"
          a={String(a.detail.piiSpans.length)}
          b={String(b.detail.piiSpans.length)}
        />
      </div>

      {(a.assertions.length > 0 || b.assertions.length > 0) && (
        <Card title="Correctness (assertions)">
          <div className="grid grid-cols-[1fr_1fr] gap-4">
            <AssertionList assertions={a.assertions} />
            <AssertionList assertions={b.assertions} />
          </div>
        </Card>
      )}
    </div>
  );
}

function SideHeader({ side }: { side: Side }) {
  return (
    <div>
      <Link
        to={'/runs/' + side.run.id}
        className="text-sm font-medium text-slate-200 hover:underline"
      >
        {side.run.title}
      </Link>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <Badge tone="muted">{side.run.kind}</Badge>
        <Badge tone={RUN_STATUS_TONE[side.run.status]}>{humanStatus(side.run.status)}</Badge>
        <span className="text-xs text-slate-600">{relativeTime(side.run.createdAt)}</span>
      </div>
    </div>
  );
}

function Row({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <>
      <div className="py-1.5 text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="border-t border-slate-800 py-1.5 text-slate-200">{a}</div>
      <div className="border-t border-slate-800 py-1.5 text-slate-200">{b}</div>
    </>
  );
}

function versionLabel(side: Side, other: Side, sameGraph: boolean | null): string {
  if (!side.graph) return side.run.kind === 'baseline' ? 'n/a — no graph' : '—';
  if (!other.graph) return 'v' + side.graph.version;
  if (sameGraph) {
    return side.graph.version === other.graph.version
      ? 'v' + side.graph.version + ' (same version)'
      : 'v' + side.graph.version;
  }
  return 'v' + side.graph.version + ' (different graph)';
}

function toolReductionLabel(analytics: RunAnalytics): string {
  const { toolsAvailable, toolsExposed } = analytics.totals;
  if (toolsAvailable === 0) return 'n/a — no tools routed';
  return toolsExposed + ' of ' + toolsAvailable;
}

function approvalsLabel(side: Side): string {
  const { approvals, approvalsPending } = side.analytics.totals;
  if (approvals === 0) return side.run.kind === 'baseline' ? '0 — cannot gate' : '0';
  return approvals + (approvalsPending > 0 ? ' (' + approvalsPending + ' pending)' : '');
}

function AssertionList({ assertions }: { assertions: AssertionResult[] }) {
  if (assertions.length === 0) {
    return <p className="text-xs text-slate-600">No assertions evaluated for this side.</p>;
  }
  return (
    <ul className="space-y-1.5 text-xs">
      {assertions.map((assertion) => (
        <li key={assertion.id} className="flex items-start gap-1.5">
          <span className={assertion.passed ? 'text-emerald-400' : 'text-rose-400'}>
            {assertion.passed ? '✓' : '✗'}
          </span>
          <span className="text-slate-400">
            {assertion.description}
            <span className="block text-slate-600">
              expected {assertion.expected}, got {assertion.actual ?? '(nothing)'}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
