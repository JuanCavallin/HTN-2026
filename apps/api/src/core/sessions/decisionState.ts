import type { AgentSessionState, DecisionState } from '@htn/shared';

/** Build the only session view that may be sent to a remote Jev adapter. */
export function decisionStateFromSession(session: AgentSessionState): DecisionState {
  const safeContext = session.context
    .flatMap((entry) => (entry.sanitizedSummary ? [entry.sanitizedSummary] : []))
    .slice(-8);
  const sanitizedForRemote =
    Boolean(session.sanitizedObjective) &&
    !session.dataLabels.some((label) => label === 'secret' || label === 'local_only');
  return {
    taskSummary: session.sanitizedObjective ?? 'Local-only objective withheld.',
    contextSummary: sanitizedForRemote ? safeContext.join('\n').slice(0, 8_000) : undefined,
    dataLabels: session.dataLabels,
    sanitizedForRemote,
  };
}
