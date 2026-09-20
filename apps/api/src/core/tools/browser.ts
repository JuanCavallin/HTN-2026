/**
 * The browser executor — `3B-6` and `3B-7`.
 *
 * ============================================================================
 * THE ONE RULE: every `execute()` calls the gate with the EXACT `ToolAction`
 * and runs only on an explicit allow. Deny, a thrown error, a timeout and a
 * missing response all block — see `guardAuthorization`, which is where those
 * four paths live so that they hold for Person 2's real gate too.
 *
 * THE SECOND RULE: the backend comes from the AUTHORIZATION RESULT, never from
 * config. `authorization.providerId` names the capability to use. If policy
 * allows neither backend, the step is blocked. That is what makes
 * "local-only data never reached Browserbase" a fact the egress ledger can
 * prove rather than a claim in a slide.
 *
 * THE THIRD RULE: `try/finally` around every session. TypeScript has no
 * `async with`, so a session opened inside an executor is released in a
 * `finally` that runs on success, on a mid-action throw, and on cancellation.
 * Sessions burn concurrency and money while open, and `REQUEST_RELEASE` is what
 * gets a Browserbase session to COMPLETED instead of leaving it RUNNING.
 *
 * `revisedArguments` — when a human edited the payload during approval, THOSE
 * arguments execute. Never the ones they edited away.
 * ============================================================================
 */

import type {
  AuthorizeAction,
  BrowserAdapter,
  BrowserOperation,
  Capability,
  ElementTable,
  Json,
  ProviderCallContext,
  ProviderId,
  ToolAction,
  ToolExecutor,
  ToolResult,
} from '@htn/shared';
import { LOCAL_BROWSER_DESTINATION } from '@htn/shared';
import { guardAuthorization } from './authorize.js';
import type { BrowserDecider } from './browserDecision.js';
import { escalateForConfidence } from './browserDecision.js';

export const BROWSER_EXECUTOR_REF = 'executor:browser';

/** What the executor needs from the outside. Nothing is reached for. */
export interface BrowserExecutorDeps {
  /** Capability -> adapter. The same accessor the orchestrator already uses. */
  provider<C extends Capability>(
    capability: C,
  ): C extends 'browser' | 'browser.local' ? BrowserAdapter : never;
  authorize: AuthorizeAction;
  /** Built by the caller: Jev when available, deterministic otherwise. */
  decide: BrowserDecider;
  /** Supplies TYPE_TEXT's value. Jev cannot write text — a small model does. */
  composeText?: (goal: string, fieldLabel: string, signal?: AbortSignal) => Promise<string>;
  callContext(args: { stepId?: string; policyRule: string }): ProviderCallContext;
}

interface Backend {
  capability: 'browser' | 'browser.local';
  providerId: ProviderId;
  adapter: BrowserAdapter;
}

function fail(
  action: ToolAction,
  started: number,
  destination: string,
  code: NonNullable<ToolResult['error']>['code'],
  message: string,
  reason?: string,
): ToolResult {
  return {
    actionId: action.actionId,
    ok: false,
    error: { code, message, ...(reason ? { reason } : {}) },
    destination,
    latencyMs: Date.now() - started,
  };
}

function succeed(
  action: ToolAction,
  started: number,
  destination: string,
  output: Json,
): ToolResult {
  return {
    actionId: action.actionId,
    ok: true,
    output,
    destination,
    latencyMs: Date.now() - started,
  };
}

export function createBrowserExecutor(deps: BrowserExecutorDeps): ToolExecutor {
  /**
   * Resolve the backend POLICY named. Never config.
   *
   * `providerId: 'localbrowser'` forces local. Anything else is remote. An
   * unrecognised provider id is a block, not a fallback to the default — a gate
   * that names a backend we cannot serve is a disagreement, not a permission.
   */
  function resolveBackend(providerId: ProviderId | undefined): Backend | null {
    if (providerId === 'localbrowser') {
      return {
        capability: 'browser.local',
        providerId: 'localbrowser',
        adapter: deps.provider('browser.local'),
      };
    }
    if (providerId === undefined || providerId === 'browserbase') {
      return {
        capability: 'browser',
        providerId: 'browserbase',
        adapter: deps.provider('browser'),
      };
    }
    return null;
  }

  async function run(action: ToolAction, signal?: AbortSignal): Promise<ToolResult> {
    const started = Date.now();
    const proposedDestination = action.destination;

    /* -- THE GATE. Before anything touches a browser. --------------------- */
    const guarded = await guardAuthorization(deps.authorize, action, signal);
    if (guarded.authorization.outcome !== 'allow') {
      return fail(
        action,
        started,
        proposedDestination,
        'BLOCKED',
        'Blocked by authorize_action (' +
          (guarded.failure ?? 'denied') +
          '): ' +
          guarded.authorization.reason,
        guarded.authorization.reason,
      );
    }

    const auth = guarded.authorization;

    const backend = resolveBackend(auth.providerId);
    if (!backend) {
      return fail(
        action,
        started,
        proposedDestination,
        'BLOCKED',
        'Policy named a browser backend this executor cannot serve: ' + auth.providerId,
        'no-permitted-backend',
      );
    }

    // The human-edited payload, when there is one.
    const args = auth.revisedArguments ?? action.args;
    // Policy's destination wins over the proposal's.
    const destination =
      auth.destination ??
      (backend.providerId === 'localbrowser' ? LOCAL_BROWSER_DESTINATION : proposedDestination);

    const operation = action.toolId.split('.').slice(1).join('.');
    const ctx = deps.callContext({
      stepId: action.stepId,
      policyRule: auth.reason,
    });

    /* -- A stateless, session-free operation. ----------------------------- */
    if (operation === 'close') {
      const sessionId = String(args.sessionId ?? '');
      const res = await backend.adapter.closeSession(sessionId, ctx);
      return res.ok
        ? succeed(action, started, res.meta.destination ?? destination, { closed: sessionId })
        : fail(action, started, destination, 'UPSTREAM', res.error.message);
    }

    /* -- Everything else needs a session. Open it, ALWAYS release it. ----- */
    const existingSessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
    let sessionId = existingSessionId;
    // Only close what WE opened. A session handed in by the caller is theirs.
    let ownsSession = false;

    try {
      if (!sessionId) {
        const opened = await backend.adapter.openSession(
          { ...(typeof args.url === 'string' ? { startUrl: args.url } : {}) },
          ctx,
        );
        if (!opened.ok) {
          return fail(
            action,
            started,
            opened.meta.destination ?? destination,
            'UPSTREAM',
            'Could not open a browser session: ' + opened.error.message,
          );
        }
        sessionId = opened.data.sessionId;
        ownsSession = true;

        // `browser.open` is the operation whose whole job is to open one, so it
        // hands the id back and the caller owns it from here.
        if (operation === 'open') {
          ownsSession = false;
          return succeed(action, started, opened.meta.destination ?? destination, {
            sessionId,
            // Capture the live-view URL NOW. Browserbase returns 410 Gone for
            // it once the session stops, so it cannot be fetched afterwards.
            liveViewUrl: opened.data.liveViewUrl ?? null,
            backend: backend.providerId,
          });
        }
      }

      switch (operation) {
        case 'search':
        case 'extract': {
          const instruction = String(args.instruction ?? args.query ?? '');
          const res = await backend.adapter.extract<Json>({ sessionId, instruction }, ctx);
          return res.ok
            ? succeed(action, started, res.meta.destination ?? destination, res.data)
            : fail(action, started, destination, 'UPSTREAM', res.error.message);
        }

        case 'inspect': {
          const table = await snapshotOrFail(backend.adapter, sessionId, ctx);
          if ('error' in table) {
            return fail(action, started, destination, 'UPSTREAM', table.error);
          }
          // A step's output is streamed and STORED. The table is small and
          // carries no page text beyond control labels, so it is safe to
          // return — but it is still metadata about the page, not the page.
          return succeed(action, started, destination, table.value as unknown as Json);
        }

        case 'click':
        case 'type':
        case 'submit': {
          const goal = String(args.goal ?? args.instruction ?? '');

          const table = await snapshotOrFail(backend.adapter, sessionId, ctx);
          if ('error' in table) {
            return fail(action, started, destination, 'UPSTREAM', table.error);
          }

          const allowedOperations: BrowserOperation[] =
            operation === 'type' ? ['TYPE_TEXT', 'SELECT'] : ['CLICK'];

          const decision = await deps.decide({
            goal,
            table: table.value,
            allowedOperations,
            ...(signal ? { signal } : {}),
          });

          // LOW CONFIDENCE ESCALATES, never the reverse. A coin-flip between
          // two buttons on a `verify` action is exactly when a person looks.
          const { riskClass, escalated } = escalateForConfidence(
            auth.riskClass,
            decision.confidence,
          );
          if (escalated) {
            // Re-gate the now-stricter action rather than proceeding. The gate
            // is the only thing that may turn `ask_human` into an allow.
            const reGated = await guardAuthorization(
              deps.authorize,
              { ...action, args: { ...args, _escalated: true } },
              signal,
            );
            if (reGated.authorization.outcome !== 'allow') {
              return fail(
                action,
                started,
                destination,
                'BLOCKED',
                'Low Jev confidence (' +
                  decision.confidence.toFixed(2) +
                  ') escalated this to ' +
                  riskClass +
                  ' and it was not approved.',
                'low-confidence-escalated',
              );
            }
          }

          if (decision.index === undefined) {
            return fail(
              action,
              started,
              destination,
              'BAD_INPUT',
              'The decision produced no target (' + decision.operation + '): ' + decision.rationale,
              decision.operation === 'BLOCKED' ? 'blocked-by-decider' : 'no-target',
            );
          }

          // A chosen index MUST be one we offered. Belt and braces: the
          // criteria only contained eligible indices, but an index we did not
          // offer is a contract violation, not an action to attempt.
          const row = table.value.rows.find((r) => r.index === decision.index);
          if (!row) {
            return fail(
              action,
              started,
              destination,
              'BAD_INPUT',
              'The decider returned index ' + decision.index + ', which was not offered.',
              'index-not-offered',
            );
          }

          let text: string | undefined;
          if (decision.operation === 'TYPE_TEXT' || decision.operation === 'SELECT') {
            // Jev picks the FIELD. The VALUE comes from args, or from a small
            // generative model. Jev cannot produce it.
            text =
              typeof args.text === 'string'
                ? args.text
                : deps.composeText
                  ? await deps.composeText(goal, row.label, signal)
                  : '';
          }

          if (!backend.adapter.perform) {
            return fail(
              action,
              started,
              destination,
              'UNAVAILABLE',
              'Backend ' + backend.providerId + ' does not implement the element-level path.',
            );
          }

          const res = await backend.adapter.perform(
            {
              sessionId,
              snapshotId: table.value.snapshotId,
              operation: decision.operation,
              index: decision.index,
              ...(text !== undefined ? { text } : {}),
            },
            ctx,
          );

          if (!res.ok) {
            return fail(
              action,
              started,
              destination,
              res.error.code === 'BAD_INPUT' ? 'BAD_INPUT' : 'UPSTREAM',
              res.error.message,
              // The adapter's freshness/occlusion refusals arrive here as
              // BAD_INPUT with a TargetRejection message. Surfacing it as the
              // reason is what lets the caller re-snapshot and retry.
              res.error.message,
            );
          }

          return succeed(action, started, res.meta.destination ?? destination, {
            operation: res.data.operation,
            index: res.data.index ?? null,
            target: row.label,
            url: res.data.url,
            navigated: res.data.navigated,
            // TRUTHFUL LABELING: the UI must not show a string match as a model
            // decision, or a cache replay as a live call.
            decisionSource: decision.source,
            confidence: decision.confidence,
            rationale: decision.rationale,
          });
        }

        default:
          return fail(
            action,
            started,
            destination,
            'UNKNOWN_TOOL',
            'Unknown browser operation: ' + action.toolId,
          );
      }
    } catch (err) {
      return fail(
        action,
        started,
        destination,
        'UPSTREAM',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      // Runs on success, on a mid-action throw, and on cancellation. This is
      // the entire reason a session does not leak.
      if (ownsSession && sessionId) {
        await backend.adapter
          .closeSession(
            sessionId,
            deps.callContext({ stepId: action.stepId, policyRule: 'session-release' }),
          )
          .catch((err: unknown) => {
            // Never let cleanup mask the real error that sent us here.
            console.error('[browser] failed to release session ' + sessionId + ':', err);
          });
      }
    }
  }

  return { ref: BROWSER_EXECUTOR_REF, execute: run };
}

async function snapshotOrFail(
  adapter: BrowserAdapter,
  sessionId: string,
  ctx: ProviderCallContext,
): Promise<{ value: ElementTable } | { error: string }> {
  if (!adapter.snapshot) {
    return { error: 'This browser backend does not implement snapshot().' };
  }
  const res = await adapter.snapshot({ sessionId }, ctx);
  return res.ok ? { value: res.data } : { error: res.error.message };
}
