import type { Step } from '@htn/shared';
import { Badge } from '../ui/Badge';
import { Spinner } from '../ui/Spinner';
import { duration, humanStatus, STEP_STATUS_TONE } from '../../lib/format';

const ICONS: Record<string, string> = {
  fetch: '▤',
  redact: '◐',
  decide: '◆',
  swarm: '⋯',
  worker: '•',
  judge: '⚖',
  submit: '↥',
  task: '▸',
};

export function StepRow({ step }: { step: Step }) {
  const tone = STEP_STATUS_TONE[step.status];

  return (
    <div className="flex items-start gap-3 py-2">
      <span
        className={
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ' +
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
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-200">{step.label}</span>

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

          <span className="ml-auto text-xs text-slate-600">
            {duration(step.startedAt, step.endedAt)}
          </span>
        </div>

        {step.error && <p className="mt-1 text-xs text-rose-400">{step.error.message}</p>}

        {step.output !== undefined && step.status === 'succeeded' && (
          <pre className="mt-1 max-h-24 overflow-auto rounded bg-slate-950/60 px-2 py-1 text-[11px] leading-relaxed text-slate-500">
            {JSON.stringify(step.output, null, 1)}
          </pre>
        )}
      </div>
    </div>
  );
}
