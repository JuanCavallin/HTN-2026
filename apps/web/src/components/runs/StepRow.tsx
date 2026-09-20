import { useEffect, useState } from 'react';
import type { Step } from '@htn/shared';
import { NODE_TYPE_ICON } from '@htn/shared';
import { Badge } from '../ui/Badge';
import { Spinner } from '../ui/Spinner';
import { StepOutput } from './StepOutput';
import { StepDevPanel } from './StepDevPanel';
import { useRunDev } from './RunDevContext';
import { duration, humanStatus, STEP_STATUS_TONE } from '../../lib/format';

/**
 * Sourced from @htn/shared so the timeline and the graph canvas cannot show
 * different marks for the same work. Adding a node type there adds it here.
 */
const ICONS: Record<string, string> = NODE_TYPE_ICON;

export function StepRow({ step }: { step: Step }) {
  const tone = STEP_STATUS_TONE[step.status];
  const { devMode, scheduleDecisions, egress } = useRunDev();

  // Dev mode sets the DEFAULT, it does not lock the row: flipping the global
  // switch opens everything, and you can still close individual rows
  // afterwards without the switch fighting you. A row also opens on its own
  // when it fails, because that is the one time nobody wants to hunt for the
  // detail -- see the effect below.
  const [open, setOpen] = useState(devMode);
  useEffect(() => setOpen(devMode), [devMode]);
  useEffect(() => {
    if (step.status === 'failed') setOpen(true);
  }, [step.status]);

  // A count worth surfacing on the collapsed row, so you can see there IS
  // something underneath without opening it.
  const decision = scheduleDecisions.find((d) => d.stepId === step.id);
  const stepEgress = egress.filter((e) => e.stepId === step.id).length;
  const routeFailed =
    decision !== undefined &&
    decision.exposedTools.length === 0 &&
    decision.availableTools.length > 0;

  return (
    <div className="flex items-start gap-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={(open ? 'Hide' : 'Show') + ' details for ' + step.label}
        title={(open ? 'Hide' : 'Show') + ' step details'}
        className={
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ' +
          'transition-transform hover:scale-110 ' +
          (step.status === 'succeeded'
            ? 'bg-emerald-500/20 text-emerald-300'
            : step.status === 'failed'
              ? 'bg-rose-500/20 text-rose-300'
              : step.status === 'blocked'
                ? 'bg-amber-500/20 text-amber-300'
                : 'bg-slate-700/50 text-slate-400')
        }
      >
        {ICONS[step.kind] ?? '▸'}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {/* The label carries the disclosure, so the click target is the
              whole name rather than a 16px dot. The caret is the affordance;
              the icon button to the left is the same toggle for anyone
              aiming at the status mark. */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="group flex items-center gap-1.5 text-left"
          >
            <span
              aria-hidden
              className={
                'text-[9px] text-slate-600 transition-transform group-hover:text-slate-400 ' +
                (open ? 'rotate-90' : '')
              }
            >
              ▶
            </span>
            <span className="text-sm text-slate-200 group-hover:text-white">{step.label}</span>
          </button>

          {step.status === 'running' && <Spinner />}

          {step.status !== 'running' && step.status !== 'succeeded' && (
            <Badge tone={tone}>{humanStatus(step.status)}</Badge>
          )}

          {step.providerId && (
            <Badge tone="muted" title="Provider that served this step">
              {step.providerId}
            </Badge>
          )}

          {step.riskClass && step.riskClass !== 'auto' && (
            <Badge tone={step.riskClass === 'ask_human' ? 'warn' : 'accent'}>
              {humanStatus(step.riskClass)}
            </Badge>
          )}

          {/* Surfaced on the COLLAPSED row: a task that ran with no tools is
              the failure most often mistaken for a plain timeout, so it must
              be visible without expanding anything. */}
          {routeFailed && (
            <Badge tone="bad" title="The router exposed no tools — this task ran with none">
              no tools
            </Badge>
          )}

          {stepEgress > 0 && (
            <span className="text-[10px] text-slate-600" title="Ledger entries for this step">
              {stepEgress} egress
            </span>
          )}

          <span className="ml-auto text-xs text-slate-600">
            {duration(step.startedAt, step.endedAt)}
          </span>
        </div>

        {/* Collapsed: one line. The full message, which carries the actionable
            tail, is in the dev panel. */}
        {step.error && !open && (
          <p className="mt-1 truncate text-xs text-rose-400">{step.error.message}</p>
        )}

        {step.output !== undefined && step.status === 'succeeded' && (
          <StepOutput kind={step.kind} output={step.output} />
        )}

        {open && <StepDevPanel step={step} />}
      </div>
    </div>
  );
}
