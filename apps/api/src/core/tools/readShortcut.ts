import type { StoredEvent, ToolDescriptor } from '@htn/shared';

const FAST_FINAL_READ_TOOLS = new Set(['weather.forecast']);

export interface VerifiedReadShortcut {
  result: string;
  toolCalls: { tool: string; args?: unknown; at: string }[];
}

/**
 * A verified structured read can itself be the final answer. Waiting for a
 * second harness model turn merely to paraphrase it adds latency and another
 * failure point. Keep this allowlist deliberately narrow: event summaries are
 * compact, so large record reads (mail, documents) still need synthesis.
 */
export function verifiedReadShortcut(
  events: StoredEvent[],
  stepId: string,
  requiredToolIds: ReadonlySet<string>,
  descriptors: ToolDescriptor[],
): VerifiedReadShortcut | null {
  if (requiredToolIds.size === 0) return null;

  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  for (const toolId of requiredToolIds) {
    const descriptor = descriptorById.get(toolId);
    if (
      !FAST_FINAL_READ_TOOLS.has(toolId) ||
      descriptor?.baselineEffect !== 'read' ||
      descriptor.reversibility !== 'reversible'
    ) {
      return null;
    }
  }

  const successes = new Map<string, { summary: string; args: unknown; at: string }>();
  for (const stored of events) {
    if (stored.event.type !== 'tool.lifecycle') continue;
    const lifecycle = stored.event.lifecycle;
    if (
      lifecycle.stepId !== stepId ||
      lifecycle.phase !== 'succeeded' ||
      lifecycle.outputVerified !== true ||
      !requiredToolIds.has(lifecycle.action.toolId) ||
      !lifecycle.outputSummary
    ) {
      continue;
    }
    successes.set(lifecycle.action.toolId, {
      summary: lifecycle.outputSummary,
      args: lifecycle.action.arguments,
      at: lifecycle.at,
    });
  }
  if ([...requiredToolIds].some((toolId) => !successes.has(toolId))) return null;

  const ordered = [...requiredToolIds].map((toolId) => ({
    toolId,
    success: successes.get(toolId)!,
  }));
  return {
    result: ordered.map(({ success }) => success.summary).join('\n'),
    toolCalls: ordered.map(({ toolId, success }) => ({
      tool: toolId,
      args: success.args,
      at: success.at,
    })),
  };
}
