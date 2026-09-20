/**
 * Tool ROUTES: who actually executes a graph's tool call.
 *
 * A `tool` node, a `dispatch` node's chosen tool and a swarm's `workerTool` all
 * end in "call the tool named X". Until now that meant exactly one place -- the
 * `toolbox` capability (Composio). It no longer does: `web.search` runs on OUR
 * gated browser, and an agent built on Composio or an MCP server will want a
 * path of its own. A route is one such path.
 *
 *   routes are asked in registration order; the first whose `handles()` says yes
 *   owns the call. `toolboxRoute` is the built-in fallback and is asked LAST, so
 *   registering a route can only ever take a tool away from the default, never
 *   leave one unowned.
 *
 * TO ADD A KIND OF TOOL: implement `ToolRoute`, `registerToolRoute()` it at
 * boot (services/toolRoutes.ts). Nothing in the interpreter, the synthesis
 * prompt or the graph schema changes -- a tool is just a name.
 *
 * THE GATING CONTRACT, which is the thing worth reading twice:
 *
 *   gatesItself: false  the INTERPRETER classifies the call (core/risk.ts via
 *                       toolRisk) and asks a human when policy says so, then
 *                       calls the route. Right for a route with no gate of its
 *                       own, like the toolbox.
 *   gatesItself: true   the route runs `authorize_action` itself, on the exact
 *                       concrete action, and so the interpreter must NOT gate
 *                       again. Gating in both places double-asks a human, or
 *                       tempts someone to skip the real gate "because the
 *                       interpreter already did". (Same rule as
 *                       core/tools/executor.ts.)
 *
 * This file stays in core, so it imports no provider and no service: the routes
 * that need one are registered from outside.
 */

import type { Json, ProviderId } from '@htn/shared';
import type { PlaybookContext } from '../playbooks/types.js';

export interface ToolCallRequest {
  stepId: string;
  tool: string;
  args: Record<string, Json>;
  /** Human-readable, shown in an approval panel and the trace. */
  description: string;
  /** For routes that write a provider ledger row: which rule allowed this call. */
  policyRule: string;
}

export interface ToolRoute {
  id: string;
  /** Does this route own `tool`? Sync or async -- a route may need to look one up. */
  handles(tool: string): boolean | Promise<boolean>;
  gatesItself: boolean;
  /** Which provider to badge the step with. Labelling only -- the ledger records the truth. */
  providerFor(ctx: PlaybookContext): ProviderId;
  /** Runs the tool and returns its result. THROW on failure so the step fails. */
  call(ctx: PlaybookContext, request: ToolCallRequest): Promise<unknown>;
}

/** The original path: everything not claimed elsewhere goes to the toolbox. */
export const toolboxRoute: ToolRoute = {
  id: 'toolbox',
  handles: () => true,
  gatesItself: false,
  providerFor: (ctx) => ctx.providerFor('toolbox'),
  async call(ctx, request) {
    const res = await ctx
      .provider('toolbox')
      .callTool(
        { name: request.tool, args: request.args },
        ctx.callContext({ stepId: request.stepId, policyRule: request.policyRule }),
      );
    if (!res.ok) throw new Error('Tool ' + request.tool + ' failed: ' + res.error.message);
    return res.data;
  },
};

const registered: ToolRoute[] = [];

/** Re-registering an id replaces it, so a hot restart or a test cannot stack duplicates. */
export function registerToolRoute(route: ToolRoute): void {
  const at = registered.findIndex((r) => r.id === route.id);
  if (at === -1) registered.push(route);
  else registered[at] = route;
}

export async function routeFor(tool: string): Promise<ToolRoute> {
  for (const route of registered) {
    if (await route.handles(tool)) return route;
  }
  return toolboxRoute;
}
