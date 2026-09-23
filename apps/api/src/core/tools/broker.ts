import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';
import type {
  AgentSessionState,
  AuthorizationDecision,
  ContentAnalysisAdapter,
  DataLabel,
  Json,
  ProviderCallContext,
  ToolAction,
  ToolDescriptor,
  ToolLifecycleEvent,
} from '@htn/shared';
import { newId, nowIso } from '../../lib/ids.js';
import type { RunBus } from '../bus.js';
import type { DecisionService } from '../decisions/service.js';
import { decisionStateFromSession } from '../sessions/decisionState.js';
import type { SessionStateService } from '../sessions/service.js';
import type { ToolApprovalGate } from './approval.js';
import { checkOutboundText } from './contentCheck.js';
import type { ToolExecutorRegistry, ToolExecutionOutput } from './executors.js';
import { modelToolText } from './executors.js';
import type { RegisteredTool, ToolRegistry } from './registry.js';

export type ToolBrokerErrorCode =
  | 'TOOL_NOT_REGISTERED'
  | 'TOOL_NOT_SELECTED'
  | 'TOOL_VERSION_CHANGED'
  | 'TOOL_UNAVAILABLE'
  | 'TOOL_SCOPE_MISSING'
  | 'TOOL_SCHEMA_INVALID'
  | 'TOOL_ARGUMENTS_INVALID'
  | 'TOOL_EXECUTOR_UNAVAILABLE'
  | 'TOOL_DESTINATION_UNKNOWN'
  | 'TOOL_ACTION_DENIED'
  | 'TOOL_APPROVAL_UNAVAILABLE'
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_VERIFICATION_FAILED';

export class ToolBrokerError extends Error {
  constructor(
    readonly code: ToolBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolBrokerError';
  }
}

export interface ToolExecutionRequest {
  sessionStateId: string;
  /** Captured by the authenticated gateway, not by the model. */
  expectedTurn?: number;
  toolId: string;
  arguments: Json;
  /** Labels may be added for a particular payload, but session labels cannot be removed. */
  dataLabels?: DataLabel[];
  signal?: AbortSignal;
}

export interface ToolBrokerResult extends ToolExecutionOutput {
  action: ToolAction;
  authorization: AuthorizationDecision;
  approvalId?: string;
}

export interface ToolBrokerOptions {
  approvalGate?: ToolApprovalGate;
  ajv?: Ajv;
  /**
   * Optional outbound-text authenticity check. Advisory and ESCALATE-ONLY:
   * see core/tools/contentCheck.ts. Omitting it disables the check entirely
   * rather than blocking, which is why it is not required to construct a broker.
   */
  contentCheck?: { analysis: ContentAnalysisAdapter; threshold?: number };
}

/**
 * The only sanctioned execution path for harness-requested tools. Every call is
 * checked against the selected descriptor and exact arguments immediately
 * before the registered executor runs. Every failure is fail-closed.
 */
export class ToolBroker {
  private readonly approvalGate?: ToolApprovalGate;
  private readonly contentCheck?: ToolBrokerOptions['contentCheck'];
  private readonly ajv: Ajv;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly executors: ToolExecutorRegistry,
    private readonly decisions: DecisionService,
    private readonly sessions: SessionStateService,
    private readonly bus: RunBus,
    options: ToolBrokerOptions = {},
  ) {
    this.approvalGate = options.approvalGate;
    this.contentCheck = options.contentCheck;
    this.ajv = options.ajv ?? new Ajv({ allErrors: true, strict: true });
  }

  async execute(request: ToolExecutionRequest): Promise<ToolBrokerResult> {
    const session = await this.sessions.get(request.sessionStateId);
    if (!session) {
      throw new ToolBrokerError(
        'TOOL_NOT_SELECTED',
        'Agent session state not found: ' + request.sessionStateId,
      );
    }
    if (request.expectedTurn !== undefined && request.expectedTurn !== session.turn) {
      throw new ToolBrokerError('TOOL_NOT_SELECTED', 'Stale gateway turn.');
    }

    const registered = await this.registry.get(request.toolId);
    if (!registered) {
      throw new ToolBrokerError('TOOL_NOT_REGISTERED', 'Unknown tool: ' + request.toolId);
    }
    const exactArguments = deepFreeze(structuredClone(request.arguments));
    this.assertSelected(session, registered.descriptor);
    this.assertAvailable(registered.descriptor);
    this.assertScopes(registered);
    this.validateArguments(registered, exactArguments);

    const executor = this.executors.resolve(registered.descriptor.executorRef);
    if (!executor) {
      throw new ToolBrokerError(
        'TOOL_EXECUTOR_UNAVAILABLE',
        'No executor is registered for ' + registered.descriptor.executorRef,
      );
    }
    const destination = executor.destinationFor({
      descriptor: registered.descriptor,
      arguments: exactArguments,
    });
    if (!destination) {
      throw new ToolBrokerError(
        'TOOL_DESTINATION_UNKNOWN',
        'The exact destination could not be resolved before authorization.',
      );
    }

    // Reassigned when a human revises the payload; the revision replaces this
    // and is reauthorized before anything executes.
    let action = deepFreeze<ToolAction>({
      id: newId('act'),
      runId: session.runId,
      stepId: session.stepId,
      toolId: registered.descriptor.id,
      descriptorVersion: registered.descriptor.version,
      operation: registered.descriptor.id,
      arguments: exactArguments,
      destination,
      dataLabels: mergeLabels(session.dataLabels, request.dataLabels ?? []),
      createdAt: nowIso(),
    });
    await this.emit(session, action, 'proposed');
    await this.bus.emit(session.runId, {
      type: 'harness.turn',
      turn: {
        id: newId('turn'),
        runId: session.runId,
        sessionId: session.harnessSessionId ?? session.id,
        turnId: (session.harnessSessionId ?? session.id) + ':' + session.turn,
        phase: 'tool_proposed',
        payload: { actionId: action.id, toolId: action.toolId },
        at: nowIso(),
      },
    });

    const callContext: ProviderCallContext = {
      runId: session.runId,
      stepId: session.stepId,
      policyRule: 'exact-tool-action-authorization',
      signal: request.signal,
    };
    let authorization = await this.decisions.authorizeAction(
      decisionStateFromSession(session),
      action,
      registered.descriptor,
      callContext,
    );
    await this.emit(session, action, 'policy_decided', { authorization });
    await this.bus.emit(session.runId, {
      type: 'control.decided',
      decision: {
        id: newId('ctl'),
        runId: session.runId,
        stepId: session.stepId,
        operation: 'recommend_action_policy',
        candidateIds: ['auto', 'verify', 'ask_user', 'deny'],
        selectedIds: [authorization.finalPolicy],
        confidence: authorization.recommendation.confidence,
        reasonCodes: authorization.reasonCodes,
        source: 'deterministic',
        at: nowIso(),
      },
    });

    // Outbound-text authenticity. Runs AFTER authorization because it is not an
    // authorization: it can only take a policy the gate already settled on and
    // make it stricter. A failure here leaves the policy untouched, so a GPTZero
    // outage cannot block an action the gate permitted. See contentCheck.ts.
    if (this.contentCheck) {
      const checked = await checkOutboundText(
        this.contentCheck.analysis,
        action,
        registered.descriptor,
        authorization.finalPolicy,
        callContext,
        { threshold: this.contentCheck.threshold },
      );

      if (checked.outcome !== 'skipped') {
        await this.bus.emit(session.runId, {
          type: 'control.decided',
          decision: {
            id: newId('ctl'),
            runId: session.runId,
            stepId: session.stepId,
            operation: 'check_outbound_text',
            candidateIds: ['passed', 'escalated', 'unavailable'],
            selectedIds: [checked.outcome],
            // The score IS the confidence here: P(ai) is what the check measured.
            confidence: checked.score ?? 0,
            reasonCodes: checked.reasonCodes,
            source: 'deterministic',
            at: nowIso(),
          },
        });
      }

      if (checked.policy !== authorization.finalPolicy) {
        authorization = {
          ...authorization,
          finalPolicy: checked.policy,
          reasonCodes: [...authorization.reasonCodes, ...checked.reasonCodes],
        };
        await this.emit(session, action, 'policy_decided', { authorization });
      }
    }

    if (authorization.finalPolicy === 'deny') {
      await this.emit(session, action, 'blocked', {
        authorization,
        error: { code: 'TOOL_ACTION_DENIED', message: 'Exact tool action was denied.' },
      });
      throw new ToolBrokerError('TOOL_ACTION_DENIED', 'Exact tool action was denied.');
    }

    let approvalId: string | undefined;
    if (authorization.finalPolicy === 'ask_user') {
      if (!this.approvalGate) {
        await this.emit(session, action, 'blocked', {
          authorization,
          error: {
            code: 'TOOL_APPROVAL_UNAVAILABLE',
            message: 'No approval gate is configured.',
          },
        });
        throw new ToolBrokerError(
          'TOOL_APPROVAL_UNAVAILABLE',
          'No approval gate is configured; refusing tool execution.',
        );
      }
      await this.emit(session, action, 'awaiting_approval', { authorization });
      let receipt;
      try {
        receipt = await this.approvalGate.request(
          { action, descriptor: registered.descriptor, authorization },
          request.signal,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Tool approval failed.';
        await this.emit(session, action, 'blocked', {
          authorization,
          error: { code: 'TOOL_ACTION_DENIED', message },
        });
        throw error;
      }
      approvalId = receipt.approvalId;

      // A revision is a DIFFERENT action, so it goes through the same gate the
      // original did: schema validation, destination resolution, and a second
      // authorizeAction. Skipping any of these would make "revise" the one way
      // to get an unauthorized payload executed.
      if (receipt.revisedArguments !== undefined) {
        const revisedArguments = deepFreeze(structuredClone(receipt.revisedArguments));
        this.validateArguments(registered, revisedArguments);

        const revisedDestination = executor.destinationFor({
          descriptor: registered.descriptor,
          arguments: revisedArguments,
        });
        if (revisedDestination !== destination) {
          const message =
            'A revision may not change the destination (' +
            destination +
            ' -> ' +
            String(revisedDestination) +
            ').';
          await this.emit(session, action, 'blocked', {
            authorization,
            approvalId,
            error: { code: 'TOOL_ACTION_DENIED', message },
          });
          throw new ToolBrokerError('TOOL_ACTION_DENIED', message);
        }

        action = deepFreeze<ToolAction>({ ...action, arguments: revisedArguments });
        await this.emit(session, action, 'proposed', { authorization, approvalId });

        authorization = await this.decisions.authorizeAction(
          decisionStateFromSession(session),
          action,
          registered.descriptor,
          { ...callContext, policyRule: 'revised-tool-action-reauthorization' },
        );
        await this.emit(session, action, 'policy_decided', { authorization, approvalId });

        // 'ask_user' again would mean the revision is no safer than what the
        // human was already shown, and re-prompting the same person for the
        // payload they just wrote is a loop, not a gate. Fail closed instead.
        if (!authorization.allowed || authorization.finalPolicy === 'deny') {
          const message = 'The revised tool action was not authorized.';
          await this.emit(session, action, 'blocked', {
            authorization,
            approvalId,
            error: { code: 'TOOL_ACTION_DENIED', message },
          });
          throw new ToolBrokerError('TOOL_ACTION_DENIED', message);
        }
      }

      await this.emit(session, action, 'approved', { authorization, approvalId });
    } else if (!authorization.allowed) {
      throw new ToolBrokerError(
        'TOOL_ACTION_DENIED',
        'Authorization did not explicitly allow execution.',
      );
    }

    const currentSession = await this.sessions.get(session.id);
    if (
      !currentSession ||
      currentSession.turn !== session.turn ||
      !['created', 'running', 'awaiting_approval'].includes(currentSession.status)
    ) {
      throw new ToolBrokerError('TOOL_NOT_SELECTED', 'The authorized turn is no longer active.');
    }
    this.assertSelected(currentSession, registered.descriptor);
    if (request.signal?.aborted)
      throw new ToolBrokerError('TOOL_ACTION_DENIED', 'Tool call cancelled.');
    await this.emit(session, action, 'executing', { authorization, approvalId });
    let executed: ToolExecutionOutput;
    try {
      executed = await executor.execute(action, {
        ...callContext,
        sessionStateId: session.id,
        policyRule: approvalId ? 'human-approved-exact-tool-action' : 'authorized-tool-action',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool executor failed.';
      await this.emit(session, action, 'failed', {
        authorization,
        approvalId,
        error: { code: 'TOOL_EXECUTION_FAILED', message },
      });
      throw new ToolBrokerError('TOOL_EXECUTION_FAILED', message);
    }

    if (authorization.finalPolicy === 'verify' && executed.verified !== true) {
      await this.emit(session, action, 'failed', {
        authorization,
        approvalId,
        error: {
          code: 'TOOL_VERIFICATION_FAILED',
          message: 'Executor did not verify a policy-required result.',
        },
      });
      throw new ToolBrokerError(
        'TOOL_VERIFICATION_FAILED',
        'Executor did not verify a policy-required result.',
      );
    }

    const outputSummary = compactSummary(executed.summary);
    const outputLabels = mergeLabels(action.dataLabels, executed.dataLabels);
    executed = { ...executed, dataLabels: outputLabels };
    const sanitizedSummary =
      executed.sanitizedSummary && outputLabels.every((label) => label === 'public')
        ? compactSummary(modelToolText(executed))
        : undefined;
    await this.sessions.appendContext(session.id, [
      {
        role: 'tool',
        summary: outputSummary,
        sanitizedSummary,
        dataLabels: outputLabels,
      },
    ]);
    await this.emit(session, action, 'succeeded', {
      authorization,
      approvalId,
      outputSummary,
    });
    return { ...executed, action, authorization, approvalId };
  }

  private assertSelected(session: AgentSessionState, descriptor: ToolDescriptor): void {
    if (session.toolCeiling !== undefined && !session.toolCeiling.includes(descriptor.id)) {
      throw new ToolBrokerError(
        'TOOL_NOT_SELECTED',
        'Tool exceeds this context capability ceiling.',
      );
    }
    const grant = session.activeToolExposureGrant;
    if (!grant || grant.sessionStateId !== session.id || grant.turn !== session.turn) {
      throw new ToolBrokerError(
        'TOOL_NOT_SELECTED',
        'No active tool exposure grant exists for this turn: ' + descriptor.id,
      );
    }
    const selectedVersion = grant.selectedToolVersions[descriptor.id];
    if (!selectedVersion) {
      throw new ToolBrokerError(
        'TOOL_NOT_SELECTED',
        'Tool was not selected by the active model call: ' + descriptor.id,
      );
    }
    if (!selectedVersion || selectedVersion !== descriptor.version) {
      throw new ToolBrokerError(
        'TOOL_VERSION_CHANGED',
        'Tool descriptor version is not the version selected for this session.',
      );
    }
  }

  private assertAvailable(descriptor: ToolDescriptor): void {
    if (
      descriptor.availability !== 'available' ||
      descriptor.baselineEffect === 'unknown' ||
      descriptor.simulated
    ) {
      throw new ToolBrokerError(
        'TOOL_UNAVAILABLE',
        'Tool is unavailable, unclassified, or simulated: ' + descriptor.id,
      );
    }
  }

  private assertScopes(registered: RegisteredTool): void {
    const missing = registered.descriptor.requiredScopes.filter(
      (scope) => !registered.grantedScopes.includes(scope),
    );
    if (missing.length > 0) {
      throw new ToolBrokerError(
        'TOOL_SCOPE_MISSING',
        'Tool connection is missing required scopes: ' + missing.join(', '),
      );
    }
  }

  private validateArguments(registered: RegisteredTool, value: Json): void {
    const key = registered.descriptor.id + '@' + registered.descriptor.version;
    let validate = this.validators.get(key);
    if (!validate) {
      try {
        validate = this.ajv.compile(structuredClone(registered.inputSchema) as AnySchema);
        this.validators.set(key, validate);
      } catch (error) {
        throw new ToolBrokerError(
          'TOOL_SCHEMA_INVALID',
          'Trusted schema is invalid for ' +
            registered.descriptor.id +
            ': ' +
            (error instanceof Error ? error.message : 'unknown schema error'),
        );
      }
    }
    if (!validate(value)) {
      throw new ToolBrokerError(
        'TOOL_ARGUMENTS_INVALID',
        'Tool arguments failed validation: ' + summarizeValidationErrors(validate.errors),
      );
    }
  }

  private async emit(
    session: AgentSessionState,
    action: ToolAction,
    phase: ToolLifecycleEvent['phase'],
    details: Pick<
      ToolLifecycleEvent,
      'authorization' | 'approvalId' | 'outputSummary' | 'error'
    > = {},
  ): Promise<void> {
    await this.bus.emit(session.runId, {
      type: 'tool.lifecycle',
      lifecycle: {
        id: newId('tool_evt'),
        runId: session.runId,
        stepId: session.stepId,
        sessionStateId: session.id,
        phase,
        action,
        ...details,
        at: nowIso(),
      },
    });
  }
}

function mergeLabels(base: DataLabel[], additions: DataLabel[]): DataLabel[] {
  return [...new Set<DataLabel>([...base, ...additions])];
}

function compactSummary(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '(tool completed without a summary)';
  return normalized.length <= 320 ? normalized : normalized.slice(0, 317) + '...';
}

function summarizeValidationErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return 'unknown validation error';
  return errors
    .slice(0, 3)
    .map((error) => {
      const additionalProperty =
        error.keyword === 'additionalProperties' &&
        typeof error.params.additionalProperty === 'string'
          ? ' "' + error.params.additionalProperty + '"'
          : '';
      return (error.instancePath || '/') + ' ' + error.message + additionalProperty;
    })
    .join('; ');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
