import assert from 'node:assert/strict';
import type { StoredEvent, ToolEffect, ToolLifecyclePhase } from '@htn/shared';
import { restartRecoveryDisposition } from '../src/core/restartRecovery.js';

function lifecycle(
  seq: number,
  actionId: string,
  phase: ToolLifecyclePhase,
  effect?: ToolEffect,
): StoredEvent {
  return {
    seq,
    runId: 'run_restart_check',
    at: '2026-09-23T00:00:00.000Z',
    event: {
      type: 'tool.lifecycle',
      lifecycle: {
        id: 'life_' + seq,
        runId: 'run_restart_check',
        stepId: 'step_restart_check',
        sessionStateId: 'ses_restart_check',
        phase,
        action: {
          id: actionId,
          runId: 'run_restart_check',
          stepId: 'step_restart_check',
          toolId: effect === 'read' ? 'gmail.fetch_emails' : 'mail.send',
          descriptorVersion: '1',
          operation: effect === 'read' ? 'gmail.fetch_emails' : 'mail.send',
          ...(effect ? { effect } : {}),
          arguments: {},
          dataLabels: ['public'],
          createdAt: '2026-09-23T00:00:00.000Z',
        },
        at: '2026-09-23T00:00:00.000Z',
      },
    },
  };
}

assert.deepEqual(restartRecoveryDisposition([]), {
  resumable: true,
  reasonCode: 'restart-safe-replay',
  uncertainActionIds: [],
});

assert.equal(
  restartRecoveryDisposition([
    lifecycle(1, 'read_1', 'executing', 'read'),
    lifecycle(2, 'read_1', 'succeeded', 'read'),
  ]).resumable,
  true,
  'descriptor-proven reads may be replayed after restart',
);

assert.deepEqual(
  restartRecoveryDisposition([
    lifecycle(1, 'write_1', 'proposed', 'write'),
    lifecycle(2, 'write_1', 'awaiting_approval', 'write'),
  ]).uncertainActionIds,
  [],
  'a write that never crossed approval remains safe to reconstruct',
);

assert.deepEqual(
  restartRecoveryDisposition([
    lifecycle(1, 'write_1', 'executing', 'write'),
    lifecycle(2, 'write_1', 'failed', 'write'),
  ]).uncertainActionIds,
  ['write_1'],
  'a failed write is still uncertain once execution began',
);

assert.deepEqual(
  restartRecoveryDisposition([lifecycle(1, 'legacy_1', 'succeeded')]),
  {
    resumable: false,
    reasonCode: 'external-side-effect-uncertain',
    uncertainActionIds: ['legacy_1'],
  },
  'legacy actions without a trusted effect fail closed',
);

assert.equal(
  restartRecoveryDisposition(
    [],
    [
      {
        id: 'approval_1',
        runId: 'run_restart_check',
        stepId: 'step_restart_check',
        question: 'Send it?',
        proposedAction: {},
        reversibility: 'irreversible',
        riskClass: 'ask_human',
        policyRule: 'irreversible-action-requires-approval',
        status: 'approved',
        createdAt: '2026-09-23T00:00:00.000Z',
      },
    ],
  ).resumable,
  false,
  'approved legacy actions block replay even without broker lifecycle events',
);

console.log('PASS: restart recovery replays reads and fails closed after uncertain side effects.');
