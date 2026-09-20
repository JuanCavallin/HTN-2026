/**
 * The executor table — `3A-5`. One dispatcher, every transport.
 *
 * `S-2`'s interface is `(action: ToolAction) => Promise<ToolResult>` and it
 * lives in `@htn/shared` as `ToolExecutor`, so 3A and 3B implement the same
 * thing and Person 1 calls one function regardless of transport.
 *
 * FOUR WAYS TO BE BLOCKED, all before any I/O:
 *   - the tool is not in the registry             -> UNKNOWN_TOOL
 *   - the tool is not in the step's selected set  -> BLOCKED
 *   - the tool is unavailable/unauthenticated     -> UNAVAILABLE
 *   - the tool is a `simulated: true` fixture     -> SIMULATED
 *
 * The third and fourth are worth stating plainly. A fixture EXISTS to pad a
 * catalog so the reduction number is demonstrable; executing one would mean
 * demoing a tool that does nothing while claiming it worked. So it is an
 * error, not a no-op.
 *
 * The second is the "unselected tool call is blocked" acceptance criterion.
 * Schema hiding is an optimisation — a harness that calls a tool it was never
 * shown still gets stopped here.
 *
 * Every concrete executor calls `authorize_action` itself. This dispatcher does
 * NOT call it, on purpose: doing it in both places would either double-gate an
 * action or tempt someone to skip it downstream "because the dispatcher did it".
 */

import type { ToolAction, ToolExecutor, ToolResult } from '@htn/shared';
import type { ToolRegistry } from './registry.js';

export interface DispatcherOptions {
  registry: ToolRegistry;
  executors: readonly ToolExecutor[];
  /**
   * The tool ids the scheduler exposed for this step, by stepId. A step with
   * no entry is UNRESTRICTED — that is for steps that predate tool selection,
   * and Person 2 should populate it once selection is live.
   */
  selectedTools?: (stepId: string) => readonly string[] | undefined;
}

function blocked(
  action: ToolAction,
  started: number,
  code: NonNullable<ToolResult['error']>['code'],
  message: string,
  reason: string,
): ToolResult {
  return {
    actionId: action.actionId,
    ok: false,
    error: { code, message, reason },
    destination: action.destination,
    latencyMs: Date.now() - started,
  };
}

export function createToolDispatcher(options: DispatcherOptions): ToolExecutor {
  const byRef = new Map(options.executors.map((e) => [e.ref, e]));

  return {
    ref: 'executor:dispatcher',

    async execute(action: ToolAction, signal?: AbortSignal): Promise<ToolResult> {
      const started = Date.now();

      const descriptor = options.registry.get(action.toolId);
      if (!descriptor) {
        return blocked(
          action,
          started,
          'UNKNOWN_TOOL',
          'No descriptor registered for ' + action.toolId + '.',
          'unknown-tool',
        );
      }

      const selected = options.selectedTools?.(action.stepId);
      if (selected && !selected.includes(descriptor.id)) {
        return blocked(
          action,
          started,
          'BLOCKED',
          action.toolId + ' was not in the set selected for this step.',
          'tool-not-selected',
        );
      }

      if (descriptor.availability !== 'available') {
        return blocked(
          action,
          started,
          'UNAVAILABLE',
          action.toolId + ' is ' + descriptor.availability + '.',
          'tool-' + descriptor.availability,
        );
      }

      if (descriptor.simulated) {
        return blocked(
          action,
          started,
          'SIMULATED',
          action.toolId + ' is a labelled fixture and cannot be executed.',
          'simulated-fixture',
        );
      }

      // An approval was bound to the version in force when it was proposed. If
      // the descriptor moved underneath it, the approval no longer describes
      // what would run.
      if (action.descriptorVersion !== descriptor.version) {
        return blocked(
          action,
          started,
          'BLOCKED',
          'Descriptor version changed from ' +
            action.descriptorVersion +
            ' to ' +
            descriptor.version +
            ' since this action was proposed.',
          'descriptor-version-mismatch',
        );
      }

      const executor = byRef.get(descriptor.executorRef);
      if (!executor) {
        return blocked(
          action,
          started,
          'UNAVAILABLE',
          'No executor bound to ' + descriptor.executorRef + '.',
          'no-executor-binding',
        );
      }

      return executor.execute(action, signal);
    },
  };
}
