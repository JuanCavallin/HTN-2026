import type { Step } from '@htn/shared';
import { StepRow } from './StepRow';
import { SwarmGrid } from './SwarmGrid';

/**
 * Renders top-level steps in sequence. A step that has children is a swarm, and
 * gets a SwarmGrid underneath it — no special step type, just parentStepId.
 */
export function StepTimeline({ steps }: { steps: Step[] }) {
  const roots = steps.filter((s) => s.parentStepId === null);
  const childrenOf = (id: string) => steps.filter((s) => s.parentStepId === id);

  if (roots.length === 0) {
    return <p className="text-sm text-slate-500">Waiting for the first step…</p>;
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
