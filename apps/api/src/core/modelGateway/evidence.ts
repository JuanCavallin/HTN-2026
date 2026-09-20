import type { ModelLifecycleEvent, StoredEvent } from '@htn/shared';

export interface ModelCompletionEvidence {
  verified: boolean;
  latest?: ModelLifecycleEvent;
  failureMessage?: string;
}

/**
 * A harness transcript is not proof that inference succeeded: some harnesses
 * render an upstream error as assistant text and then stop normally. The latest
 * gateway lifecycle event is authoritative. Earlier failures are tolerated only
 * when a later retry completed successfully.
 */
export function modelCompletionEvidence(
  events: StoredEvent[],
  stepId: string,
): ModelCompletionEvidence {
  const lifecycle = events.flatMap(({ event }) =>
    event.type === 'model.lifecycle' && event.lifecycle.stepId === stepId ? [event.lifecycle] : [],
  );
  const latest = lifecycle.at(-1);
  return {
    verified: latest?.phase === 'completed',
    latest,
    failureMessage: latest?.phase === 'failed' ? latest.error?.message : undefined,
  };
}
