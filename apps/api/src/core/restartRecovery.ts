import type { Approval, StoredEvent, ToolLifecycleEvent } from '@htn/shared';

export interface RestartRecoveryDisposition {
  resumable: boolean;
  reasonCode: 'restart-safe-replay' | 'external-side-effect-uncertain';
  uncertainActionIds: string[];
}

/**
 * A restarted playbook is replayed from its durable input. Replay is safe only
 * when every tool action that reached execution was a descriptor-proven read.
 * Legacy events without a snapshotted effect fail closed.
 */
export function restartRecoveryDisposition(
  events: StoredEvent[],
  approvals: Approval[] = [],
): RestartRecoveryDisposition {
  const uncertainActionIds = new Set<string>();

  // Legacy playbooks can gate a direct provider call without going through the
  // broker lifecycle. Once that approval was granted, a crash cannot prove
  // whether the provider observed the request, so replay must remain blocked.
  for (const approval of approvals) {
    if (approval.status === 'approved' || approval.status === 'revised') {
      uncertainActionIds.add('approval:' + approval.id);
    }
  }

  for (const stored of events) {
    if (stored.event.type !== 'tool.lifecycle') continue;
    const lifecycle: ToolLifecycleEvent = stored.event.lifecycle;
    if (lifecycle.phase !== 'executing' && lifecycle.phase !== 'succeeded') continue;
    if (lifecycle.action.effect !== 'read') uncertainActionIds.add(lifecycle.action.id);
  }

  return uncertainActionIds.size > 0
    ? {
        resumable: false,
        reasonCode: 'external-side-effect-uncertain',
        uncertainActionIds: [...uncertainActionIds].sort(),
      }
    : {
        resumable: true,
        reasonCode: 'restart-safe-replay',
        uncertainActionIds: [],
      };
}
