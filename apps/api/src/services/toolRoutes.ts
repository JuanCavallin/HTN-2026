/**
 * The routes that need a service, registered once at boot.
 *
 * core/graph/toolRoutes.ts owns the contract and the toolbox fallback. Anything
 * that has to reach the tool plane lives here instead, because core must not
 * import the composition root. Adding a kind of tool means adding a route to
 * `registerToolRoutes` -- see the contract's header for the gating rule.
 */

import type { ProviderId, ToolAction } from '@htn/shared';
import { BROWSER_FAMILY } from '@htn/shared';
import { registerToolRoute, type ToolRoute } from '../core/graph/toolRoutes.js';
import { newId } from '../lib/ids.js';
import { toolPlane } from './runtime.js';

/**
 * A graph does not yet say how sensitive the data in a tool call is, so every
 * plane call is proposed as `private`: the conservative default that still
 * reaches a cloud browser (descriptors for it allow public + private) but
 * never claims `public` for something it cannot vouch for. Carrying the real
 * label from a redact/route decision is the follow-up; nothing here blocks it.
 */
const DEFAULT_DATA_LABELS = ['private'] as const;
const DEFAULT_CONTEXT_SCOPE = 'private' as const;

/**
 * Everything registered in the tool plane EXCEPT the low-level browser family.
 *
 * `browserbase.open` hands back a session id and expects the caller to close
 * it; a graph has no run-scoped cleanup, so exposing those would leak a
 * (billed, capped) session on any failure or cancel. The `web` family opens and
 * releases its own session inside one call. New plane tools -- an HTTP plugin
 * manifest, an MCP server -- route here automatically the moment they register.
 */
export const toolPlaneRoute: ToolRoute = {
  id: 'tool-plane',
  // The plane's executors call authorize_action on the CONCRETE action.
  gatesItself: true,

  async handles(tool) {
    const descriptor = (await toolPlane()).registry.get(tool);
    return descriptor !== undefined && descriptor.family !== BROWSER_FAMILY;
  },

  // Labelling only. The ledger records the backend that actually served it.
  providerFor: () => 'browserbase' satisfies ProviderId,

  async call(ctx, request) {
    const plane = await toolPlane();
    const descriptor = plane.registry.get(request.tool);
    if (!descriptor) throw new Error('Tool ' + request.tool + ' is not in the tool plane.');

    const action: ToolAction = {
      runId: ctx.runId,
      stepId: request.stepId,
      actionId: newId('act'),
      toolId: descriptor.id,
      descriptorVersion: descriptor.version,
      args: request.args,
      // A proposal only -- the executor rewrites it to the real destination.
      destination: descriptor.providerId + ':' + descriptor.id,
      dataLabels: DEFAULT_DATA_LABELS,
      contextScope: DEFAULT_CONTEXT_SCOPE,
    };

    const result = await plane.executor.execute(action, ctx.signal);
    if (!result.ok) {
      throw new Error(
        'Tool ' +
          request.tool +
          ' failed: ' +
          result.error.message +
          (result.error.reason ? ' (' + result.error.reason + ')' : ''),
      );
    }
    return result.output;
  },
};

export function registerToolRoutes(): void {
  registerToolRoute(toolPlaneRoute);
}
