import { isTerminal, type Run, type Step } from '@htn/shared';
import { StepRow } from './StepRow';
import { SwarmGrid } from './SwarmGrid';

/**
 * Renders top-level steps in sequence. A step that has children is a swarm, and
 * gets a SwarmGrid underneath it — no special step type, just parentStepId.
 */
export function StepTimeline({ steps, run }: { steps: Step[]; run?: Run }) {
  const roots = steps.filter((s) => s.parentStepId === null);
  const childrenOf = (id: string) => steps.filter((s) => s.parentStepId === id);

  if (roots.length === 0) {
    // A terminal run with zero steps didn't run with no steps -- its step
    // history just isn't available (e.g. the server restarted since it ran;
    // steps are not durable the way the run row itself is). "Waiting for the
    // first step" would be actively misleading here: nothing is coming.
    return (
      <p className="text-sm text-slate-500">
        {run && isTerminal(run.status)
          ? 'Step history unavailable for this run.'
          : 'Waiting for the first step…'}
      </p>
    );
  }

  return (
    <ol className="space-y-1">
      {roots.map((step, index) => {
        const children = childrenOf(step.id);
        return (
          <li key={step.id} className="relative">
            <div className={index < roots.length - 1 ? 'step-rail relative' : 'relative'}>
              <StepRow step={step} />
              {children.length > 0 && (
                <div className="mb-3 ml-7">
                  <SwarmGrid workers={children} />
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
