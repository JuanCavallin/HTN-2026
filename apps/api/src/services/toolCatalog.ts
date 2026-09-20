/**
 * ONE catalog of every tool a graph may name: the toolbox's, plus the tool
 * plane's.
 *
 * The graph editor's picker (`GET /api/tools`) and the chat synthesiser both
 * read this, so they cannot disagree about what exists -- and a tool that is
 * routable (core/graph/toolRoutes.ts) but missing here would be one no graph
 * could ever name.
 *
 * MERGE RULE: the plane WINS a name collision. The Composio mock lists a
 * `web.search` fixture; with a real one registered, offering both under one
 * name would let the picker show one tool while a graph ran the other.
 *
 * FAILURE NEVER WIDENS: if the toolbox is down, the plane's tools are still
 * listed -- fewer tools is the safe direction. Only when BOTH are empty does
 * the toolbox's error come back, so callers that treat "no catalog" specially
 * still see it.
 */

import type { ProviderCallContext, ProviderResult, ToolCatalogEntry } from '@htn/shared';
import { BROWSER_FAMILY } from '@htn/shared';
import { WEB_ACTION_KIND, WEB_FAMILY } from '../core/tools/index.js';
import { providers, toolPlane } from './runtime.js';

/** Family -> what its tools DO, in core/risk.ts's vocabulary. New families add a line. */
const ACTION_KIND_BY_FAMILY: Record<string, string> = {
  [WEB_FAMILY]: WEB_ACTION_KIND,
};

async function planeEntries(): Promise<ToolCatalogEntry[]> {
  const plane = await toolPlane();
  return plane.registry
    .selectToolMetadata()
    .filter((tool) => tool.family !== BROWSER_FAMILY)
    .map((tool) => {
      const actionKind = ACTION_KIND_BY_FAMILY[tool.family];
      return {
        name: tool.id,
        description: tool.description,
        group: tool.family,
        // No mapping means no `actionKind`, which the risk gate reads as
        // UNCLASSIFIED and stops for a human. Loud, and the safe direction.
        ...(actionKind ? { actionKind } : {}),
      };
    });
}

export async function listToolCatalog(
  ctx: ProviderCallContext,
): Promise<ProviderResult<ToolCatalogEntry[]>> {
  const [toolbox, plane] = await Promise.all([
    providers.provider('toolbox').listTools(ctx),
    planeEntries(),
  ]);

  const fromToolbox = toolbox.ok ? toolbox.data : [];
  if (!toolbox.ok && plane.length === 0) return toolbox;

  const planeNames = new Set(plane.map((tool) => tool.name));
  const merged = [...plane, ...fromToolbox.filter((tool) => !planeNames.has(tool.name))];

  return {
    ok: true,
    data: merged,
    meta: toolbox.meta,
  };
}
