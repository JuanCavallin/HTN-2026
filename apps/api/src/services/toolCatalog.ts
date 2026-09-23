/**
 * The tool catalog the graph SYNTHESISER is shown.
 *
 * Rebuilt against the AgentOS tool registry after the control-plane merge. The
 * previous version read the old tool plane (`createToolPlane`), which no longer
 * exists; the registry is now the trusted source of what tools are real, so
 * this reads that instead of a second catalog of its own.
 *
 * TWO SOURCES, and they are not interchangeable:
 *
 *   registry   tools AgentOS itself brokers -- browser, local, MCP-backed.
 *              Trusted metadata, schemas held server-side.
 *   toolbox    the provider's own catalog (Composio today), which a graph
 *              `tool` node still calls directly through `ctx.provider`.
 *
 * Both are listed because a graph author can legitimately name either, and a
 * synthesiser shown only half the world invents names for the other half --
 * every one of which fails classification at run time.
 *
 * The registry wins on a name collision: a tool AgentOS brokers is the one that
 * actually has a gate in front of it.
 *
 * NEVER returns schemas. Descriptor metadata only -- full input schemas stay
 * server-side, which is the registry's own rule (see core/tools/registry.ts).
 */

import type { ToolCatalogEntry } from '../core/graph/synthesisPrompt.js';
import { providers, toolRegistry } from './runtime.js';

/** Registry descriptors, as catalog entries. Unavailable tools are omitted. */
async function fromRegistry(): Promise<ToolCatalogEntry[]> {
  const registered = await toolRegistry.list();
  return registered
    .filter((tool) => tool.descriptor.availability === 'available')
    .map((tool) => ({
      name: tool.descriptor.id,
      description: tool.descriptor.description,
      group: tool.descriptor.family,
      ...(tool.descriptor.interactionMode
        ? { interactionMode: tool.descriptor.interactionMode }
        : {}),
    }));
}

/**
 * The provider's catalog. Failure is NON-FATAL: an unreachable toolbox should
 * narrow what the synthesiser is offered, never abort authoring entirely --
 * the registry half is still perfectly usable on its own.
 */
async function fromToolbox(conversationId: string): Promise<ToolCatalogEntry[]> {
  try {
    const result = await providers.provider('toolbox').listTools({
      runId: conversationId,
      policyRule: 'tool-catalog-for-synthesis',
    });
    if (!result.ok) return [];
    return result.data.map((tool) => ({
      name: tool.name,
      description: tool.description,
      ...(tool.toolkit ? { group: tool.toolkit } : {}),
    }));
  } catch {
    return [];
  }
}

export async function listToolCatalog(conversationId: string): Promise<ToolCatalogEntry[]> {
  const [registry, toolbox] = await Promise.all([fromRegistry(), fromToolbox(conversationId)]);

  const known = new Set(registry.map((tool) => tool.name));
  return [...registry, ...toolbox.filter((tool) => !known.has(tool.name))];
}
