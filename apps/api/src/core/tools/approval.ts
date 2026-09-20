import type { AuthorizationDecision, Json, ToolAction, ToolDescriptor } from '@htn/shared';
import type { Store } from '../../store/types.js';
import { newId, nowIso } from '../../lib/ids.js';
import { ApprovalRejectedError, waitForApproval } from '../approvalGate.js';
import type { RunBus } from '../bus.js';
import type { SessionStateService } from '../sessions/service.js';

export interface ToolApprovalReceipt {
  approvalId: string;
}

export interface ToolApprovalGate {
  request(
    input: {
      action: ToolAction;
      descriptor: ToolDescriptor;
      authorization: AuthorizationDecision;
    },
    signal?: AbortSignal,
  ): Promise<ToolApprovalReceipt>;
}

/** Persists an exact-action approval and blocks the caller until it is resolved. */
export class RunToolApprovalGate implements ToolApprovalGate {
  constructor(
    private readonly store: Store,
    private readonly bus: RunBus,
    private readonly sessions: SessionStateService,
  ) {}

  async request(
    input: {
      action: ToolAction;
      descriptor: ToolDescriptor;
      authorization: AuthorizationDecision;
    },
    signal?: AbortSignal,
  ): Promise<ToolApprovalReceipt> {
    const { action, descriptor, authorization } = input;
    if (authorization.finalPolicy !== 'ask_user') {
      throw new Error('Tool approval requested for a non-gated action: ' + action.id);
    }

    const approval = {
      id: newId('apr'),
      runId: action.runId,
      stepId: action.stepId,
      question: approvalQuestion(descriptor, action),
      proposedAction: exactActionJson(action),
      reversibility: descriptor.reversibility,
      riskClass: 'ask_human' as const,
      policyRule: 'exact-tool-action-requires-approval',
      status: 'pending' as const,
      createdAt: nowIso(),
    };

    await this.store.createApproval(approval);
    const blockedStep = await this.store.patchStep(action.stepId, {
      status: 'blocked',
      approvalId: approval.id,
    });
    const run = await this.store.patchRun(action.runId, { status: 'awaiting_approval' });
    await this.sessions.setStatusForStep(action.runId, action.stepId, 'awaiting_approval');
    await this.bus.emit(action.runId, { type: 'step.upserted', step: blockedStep });
    await this.bus.emit(action.runId, { type: 'run.updated', run });
    await this.bus.emit(action.runId, { type: 'approval.requested', approval });

    const outcome = await waitForApproval(approval.id, signal);

    const resumedRun = await this.store.patchRun(action.runId, { status: 'running' });
    const step = await this.store.patchStep(action.stepId, { status: 'running' });
    await this.sessions.setStatusForStep(action.runId, action.stepId, 'running');
    await this.bus.emit(action.runId, { type: 'run.updated', run: resumedRun });
    await this.bus.emit(action.runId, { type: 'step.upserted', step });

    if (outcome === 'rejected') throw new ApprovalRejectedError(approval.id);
    return { approvalId: approval.id };
  }
}

function approvalQuestion(descriptor: ToolDescriptor, action: ToolAction): string {
  const destination = action.destination ? ' to ' + action.destination : '';
  return 'Allow ' + descriptor.id + destination + '?';
}

function exactActionJson(action: ToolAction): Json {
  return {
    actionId: action.id,
    toolId: action.toolId,
    descriptorVersion: action.descriptorVersion,
    operation: action.operation,
    arguments: action.arguments,
    destination: action.destination ?? null,
    dataLabels: action.dataLabels,
  };
}
