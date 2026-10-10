import type { AgentSessionState, DecisionState } from '@htn/shared';

/** Build the only session view that may be sent to a remote Jev adapter. */
export function decisionStateFromSession(session: AgentSessionState): DecisionState {
  const safeEntries = session.context.filter((entry) => Boolean(entry.sanitizedSummary)).slice(-8);
  const latestTurnIntent = [...safeEntries]
    .reverse()
    .find((entry) => entry.role === 'user' || entry.role === 'tool');
  const sanitizedForRemote =
    Boolean(session.sanitizedObjective) &&
    !session.dataLabels.some((label) => label === 'secret' || label === 'local_only');
  return {
    // Route the current turn, not only the original task. The original goal
    // stays in context so a model switch cannot detach a subtask from intent.
    taskSummary:
      latestTurnIntent?.sanitizedSummary ??
      session.sanitizedObjective ??
      'Local-only objective withheld.',
    contextSummary: sanitizedForRemote
      ? [
          'Original objective: ' + session.sanitizedObjective,
          ...safeEntries.map((entry) => entry.role + ': ' + (entry.sanitizedSummary ?? '')),
        ]
          .join('\n')
          .slice(0, 8_000)
      : undefined,
    dataLabels: session.dataLabels,
    sanitizedForRemote,
  };
}
