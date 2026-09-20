/**
 * The expanded "dev view" for one step: what actually happened, not the
 * curated summary StepOutput shows.
 *
 * WHY THIS EXISTS. The timeline answers "did this step succeed?". It could not
 * answer the question you actually ask when a run misbehaves: WHICH TOOLS DID
 * THE AGENT CALL, and where exactly did it come apart. For an `agent_task`
 * that gap was total -- the harness runs its own loop in another process, so
 * its tool calls are self-reported, and a step that timed out used to render
 * one line of error text with every trace of what it had invoked discarded.
 *
 * Each section below is deliberately sourced from a DIFFERENT place, because
 * they can disagree and the disagreement is the diagnosis:
 *
 *   Routing      -- what the decision layer let through BEFORE the task ran.
 *                   `exposedTools: []` with rule `route-failed-safe-local`
 *                   means the router failed and the task ran tool-less. That
 *                   is a tools problem that looks like a timeout.
 *   Tool calls   -- what the harness SAYS it invoked. Present while running,
 *                   and preserved when the step fails.
 *   Egress       -- what our ledger recorded leaving the machine. If this is
 *                   shorter than the tool-call list, something was not logged.
 *
 * Everything is read-only and comes from the same stream as the rest of the
 * page (see RunDevContext) -- this panel cannot show a different truth than
 * the timeline above it.
 */

import type { EgressEvent, Json, ScheduleDecision, Step } from '@htn/shared';
import { Badge } from '../ui/Badge';
import { msLabel } from '../../lib/format';
import { useRunDev } from './RunDevContext';

const sectionClass = 'border-t border-slate-800/80 px-3 py-2 first:border-t-0';
const labelClass = 'text-[10px] font-semibold uppercase tracking-wide text-slate-500';
const monoClass = 'font-mono text-[11px] text-slate-300';
const preClass =
  'mt-1 max-h-56 overflow-auto rounded bg-slate-950/70 px-2 py-1.5 text-[11px] leading-relaxed text-slate-400';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={sectionClass}>
      <div className={labelClass}>{label}</div>
      {children}
    </div>
  );
}

function KeyValue({ pairs }: { pairs: [string, string | undefined][] }) {
  const shown = pairs.filter(([, v]) => v !== undefined && v !== '');
  if (shown.length === 0) return null;
  return (
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-600">{k}</dt>
          <dd className="truncate font-mono text-slate-400">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Tool calls the harness self-reported, newest last, with elapsed offsets. */
function ToolCallList({ calls, startedAt }: { calls: unknown[]; startedAt?: string }) {
  const base = startedAt ? new Date(startedAt).getTime() : undefined;

  return (
    <ol className="mt-1 space-y-1">
      {calls.map((call, index) => {
        const record = isRecord(call) ? call : undefined;
        const tool = typeof record?.tool === 'string' ? record.tool : String(call);
        const at = typeof record?.at === 'string' ? record.at : undefined;
        const status = typeof record?.status === 'string' ? record.status : undefined;
        const result = typeof record?.result === 'string' ? record.result : undefined;
        // Offset from the step's own start is far easier to reason about than
        // a wall-clock timestamp when you are asking "where did the time go".
        const offset =
          base !== undefined && at ? msLabel(new Date(at).getTime() - base) : undefined;
        const failed = status === 'failed';

        return (
          <li key={index} className="text-[11px]">
            <div className="flex items-baseline gap-2">
              <span className="w-5 shrink-0 text-right text-slate-700">{index + 1}</span>
              <span
                className={
                  'min-w-0 flex-1 break-all font-mono ' +
                  (failed ? 'text-rose-300' : 'text-slate-300')
                }
              >
                {tool}
              </span>
              {status && (
                <span
                  className={
                    'shrink-0 ' +
                    (failed
                      ? 'text-rose-400'
                      : status === 'completed'
                        ? 'text-emerald-500'
                        : 'text-slate-600')
                  }
                >
                  {status}
                </span>
              )}
              {offset && <span className="shrink-0 text-slate-600">+{offset}</span>}
            </div>
            {/* What the tool actually returned. This is the difference between
                "it called browser_exec" and "browser_exec returned an error",
                which the title alone can never tell you. */}
            {result && (
              <div className="ml-7 mt-0.5 whitespace-pre-wrap break-words rounded border-l-2 border-slate-800 bg-slate-950/60 px-2 py-1 text-[10px] leading-relaxed text-slate-500">
                {result}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The routing decision that produced this step's toolset.
 *
 * The failure it is built to make obvious: a router outage fails CLOSED (see
 * orchestrator.ts), so the task still runs but with zero tools. Without this
 * section that shows up only as a slow, confusing timeout.
 */
function RoutingSection({ decision }: { decision: ScheduleDecision }) {
  const available = decision.availableTools ?? [];
  const exposed = decision.exposedTools ?? [];
  const routeFailed = exposed.length === 0 && available.length > 0;

  return (
    <Section label="Routing (tools granted before the task started)">
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-slate-400">
          <span className="font-mono text-slate-300">{available.length}</span> available →{' '}
          <span
            className={'font-mono ' + (routeFailed ? 'text-rose-300' : 'text-emerald-300')}
          >
            {exposed.length}
          </span>{' '}
          exposed
        </span>
        <Badge tone={routeFailed ? 'bad' : 'muted'}>{decision.rule}</Badge>
        {decision.modelTier && <Badge tone="muted">{decision.modelTier}</Badge>}
        {decision.privacy && <Badge tone="muted">{decision.privacy}</Badge>}
      </div>

      {routeFailed && (
        <p className="mt-1.5 rounded border border-rose-500/30 bg-rose-500/5 px-2 py-1 text-[11px] text-rose-300">
          The router exposed no tools, so this task ran with none. This fails closed by design —
          a routing outage narrows what the agent can touch rather than widening it — but it means
          any goal needing a tool could not succeed. Check the decision provider's health.
        </p>
      )}

      {exposed.length > 0 && (
        <div className="mt-1.5">
          <span className="text-[10px] text-slate-600">exposed: </span>
          <span className={monoClass}>{exposed.join(', ')}</span>
        </div>
      )}
      {available.length > 0 && (
        <div className="mt-0.5">
          <span className="text-[10px] text-slate-600">withheld: </span>
          <span className="font-mono text-[11px] text-slate-500">
            {available.filter((t) => !exposed.includes(t)).join(', ') || '(none)'}
          </span>
        </div>
      )}
    </Section>
  );
}

function EgressSection({ events }: { events: EgressEvent[] }) {
  return (
    <Section label={'Egress recorded for this step (' + events.length + ')'}>
      <ul className="mt-1 space-y-0.5">
        {events.map((event) => (
          <li key={event.id} className="flex items-baseline gap-2 text-[11px]">
            <span
              className={
                'shrink-0 ' +
                (event.decision === 'blocked'
                  ? 'text-rose-400'
                  : event.decision === 'redacted'
                    ? 'text-amber-400'
                    : 'text-slate-600')
              }
            >
              {event.decision === 'allowed' ? '→' : event.decision === 'redacted' ? '◐' : '✗'}
            </span>
            <span className="min-w-0 flex-1 break-all font-mono text-slate-400">{event.op}</span>
            <span className="shrink-0 truncate text-slate-600">{event.destination}</span>
            {event.latencyMs !== undefined && (
              <span className="shrink-0 text-slate-700">{msLabel(event.latencyMs)}</span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function StepDevPanel({ step }: { step: Step }) {
  const { egress, scheduleDecisions, logs } = useRunDev();

  const decision = scheduleDecisions.find((d) => d.stepId === step.id);
  const stepEgress = egress.filter((e) => e.stepId === step.id);

  // Tool calls live on the step output, which the orchestrator writes on BOTH
  // the success and the failure path (a timed-out task keeps its evidence).
  const output = step.output;
  const toolCalls =
    isRecord(output) && Array.isArray(output.toolCalls) ? (output.toolCalls as unknown[]) : [];
  const partial = isRecord(output) && output.partial === true;

  // Logs are run-scoped with no stepId, so they are windowed to this step's
  // own lifetime. Approximate by construction -- concurrent branches interleave
  // -- and labelled as such rather than implying a precise attribution.
  const windowLogs = (() => {
    if (!step.startedAt) return [];
    const from = new Date(step.startedAt).getTime();
    const to = step.endedAt ? new Date(step.endedAt).getTime() : Date.now();
    return logs.filter((entry) => {
      const at = new Date(entry.at).getTime();
      return at >= from && at <= to;
    });
  })();

  return (
    <div className="mt-2 rounded-md border border-slate-800 bg-slate-950/50">
      <Section label="Step">
        <KeyValue
          pairs={[
            ['id', step.id],
            ['kind', step.kind],
            ['node', step.nodeId],
            ['provider', step.providerId],
            ['status', step.status],
            ['started', step.startedAt?.slice(11, 23)],
            ['ended', step.endedAt?.slice(11, 23)],
          ]}
        />
      </Section>

      {step.error && (
        <Section label="Failure">
          <div className="mt-1">
            <Badge tone="bad">{step.error.code}</Badge>
          </div>
          {/* Full text, wrapped. The timeline truncates this to one line, and
              the orchestrator's timeout messages carry the actual next step to
              take in their tail -- exactly the part that gets cut off. */}
          <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-rose-300">
            {step.error.message}
          </p>
        </Section>
      )}

      {decision && <RoutingSection decision={decision} />}

      {toolCalls.length > 0 ? (
        <Section
          label={
            'Tool calls the agent reported (' +
            toolCalls.length +
            (partial ? ', before it was stopped' : '') +
            ')'
          }
        >
          <ToolCallList calls={toolCalls} startedAt={step.startedAt} />
        </Section>
      ) : step.kind === 'agent_task' ? (
        <Section label="Tool calls the agent reported">
          <p className="mt-1 text-[11px] text-slate-500">
            None reported.{' '}
            {step.status === 'running'
              ? 'The harness has not reported a tool call yet.'
              : 'Either the agent answered without tools, or its runtime cannot report them — ' +
                'the two are indistinguishable from here.'}
          </p>
        </Section>
      ) : null}

      {stepEgress.length > 0 && <EgressSection events={stepEgress} />}

      {windowLogs.length > 0 && (
        <Section label={'Log during this step (' + windowLogs.length + ', approximate)'}>
          <ul className="mt-1 space-y-0.5">
            {windowLogs.map((entry, index) => (
              <li key={index} className="flex gap-2 text-[11px]">
                <span className="shrink-0 text-slate-700">{entry.at.slice(11, 19)}</span>
                <span
                  className={
                    'shrink-0 uppercase ' +
                    (entry.level === 'error'
                      ? 'text-rose-400'
                      : entry.level === 'warn'
                        ? 'text-amber-400'
                        : 'text-slate-600')
                  }
                >
                  {entry.level}
                </span>
                <span className="min-w-0 break-words text-slate-400">{entry.message}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {step.input !== undefined && (
        <Section label="Input">
          <pre className={preClass}>{JSON.stringify(step.input as Json, null, 2)}</pre>
        </Section>
      )}

      {step.output !== undefined && (
        <Section label="Raw output">
          <pre className={preClass}>{JSON.stringify(step.output as Json, null, 2)}</pre>
        </Section>
      )}
    </div>
  );
}
