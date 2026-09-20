/**
 * The tool registry and `select_tool_metadata` — `3A-1` and `3A-4`.
 *
 * ============================================================================
 * THE CATALOG IS DELIBERATELY EMPTY, and this file is built to work that way.
 * Which tools exist is decided at the hackathon by which sponsor APIs are worth
 * integrating; picking them now means throwing the work away or being locked
 * out of a track. So the deliverable is not the tools — it is that adding
 * provider number one through fifty is ONE MANIFEST plus ONE EXECUTOR BINDING.
 *
 * Consequence, stated plainly: the "50+ schemas reduce to 3-8" acceptance
 * criterion cannot be met until tools exist. The reduction MACHINERY is here
 * and is exercised by the browser family, which is real.
 *
 * TWO SEPARATIONS THIS FILE ENFORCES:
 *
 *   1. ROUTING METADATA vs FULL SCHEMAS. Candidates come back as
 *      `ToolMetadata` — no `schemaRef`, no `credentialRef`, no `executorRef`.
 *      Full schemas are returned only for the final selected set and only to
 *      the local caller. Jev never sees a schema or a credential.
 *   2. ELIGIBILITY vs SELECTION. An unauthenticated or unavailable provider is
 *      filtered out BEFORE Jev is asked, so it cannot be selected at all.
 *      Failure never widens the exposed set — `select_tool_metadata` on an
 *      empty or broken catalog returns nothing, and returning nothing is a
 *      correct answer, not an error.
 * ============================================================================
 */

import type { ContextScope, DataLabel, ToolDescriptor, ToolMetadata } from '@htn/shared';
import { toToolMetadata } from '@htn/shared';

export interface SelectToolMetadataQuery {
  /** The families Jev chose. Empty or omitted means every family. */
  families?: readonly string[];
  /** Specific ids, for the second stage when Jev has picked the final set. */
  toolIds?: readonly string[];
  /** Drop tools that cannot receive this step's data. */
  dataLabels?: readonly DataLabel[];
  /** Drop tools that cannot serve this step's context scope. */
  contextScope?: ContextScope;
  /** Cap the candidate list. The point of the exercise is a small number. */
  limit?: number;
}

export interface RegistryCounts {
  total: number;
  available: number;
  simulated: number;
  byFamily: Record<string, number>;
}

export interface ToolRegistry {
  register(descriptor: ToolDescriptor): void;
  registerAll(descriptors: readonly ToolDescriptor[]): void;
  /** Full descriptor, LOCAL ONLY. Never serialise this to a model. */
  get(toolId: string): ToolDescriptor | undefined;
  has(toolId: string): boolean;
  families(): string[];
  /** Routing metadata for candidates. This is the shape that may leave. */
  selectToolMetadata(query?: SelectToolMetadataQuery): ToolMetadata[];
  /** Full schemas for the FINAL set Jev picked. Local callers only. */
  schemasFor(toolIds: readonly string[]): ToolDescriptor[];
  counts(): RegistryCounts;
  clear(): void;
}

/** `Provider.Operation` -> `provider.operation`. One id format, always. */
export function normaliseToolId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, '.')
    .replace(/\.{2,}/g, '.');
}

export function createToolRegistry(): ToolRegistry {
  /** Short routing metadata. Read on every selection. */
  const descriptors = new Map<string, ToolDescriptor>();

  /**
   * Full schemas, cached SEPARATELY from the descriptors above. They are large,
   * they are local-only, and keeping them apart is what makes it hard to
   * accidentally serialise one into a model request.
   */
  const schemas = new Map<string, unknown>();

  function eligible(d: ToolDescriptor, query: SelectToolMetadataQuery): boolean {
    // Availability first: an unauthenticated provider never reaches selection.
    if (d.availability !== 'available') return false;

    if (query.families?.length && !query.families.includes(d.family)) return false;
    if (query.toolIds?.length && !query.toolIds.includes(d.id)) return false;

    // A tool must accept EVERY label the step carries. One unaccepted label
    // disqualifies it — that is the fail-closed direction.
    if (query.dataLabels?.length) {
      const ok = query.dataLabels.every((label) => d.allowedDataLabels.includes(label));
      if (!ok) return false;
    }

    if (query.contextScope && !d.allowedContextScopes.includes(query.contextScope)) {
      return false;
    }

    return true;
  }

  return {
    register(descriptor) {
      const id = normaliseToolId(descriptor.id);
      descriptors.set(id, { ...descriptor, id });
    },

    registerAll(list) {
      for (const d of list) this.register(d);
    },

    get(toolId) {
      return descriptors.get(normaliseToolId(toolId));
    },

    has(toolId) {
      return descriptors.has(normaliseToolId(toolId));
    },

    families() {
      return [...new Set([...descriptors.values()].map((d) => d.family))].sort();
    },

    selectToolMetadata(query = {}) {
      // An empty catalog returns []. It does NOT throw — a step with no tools
      // is a normal state while the sponsor list is undecided.
      const matches = [...descriptors.values()].filter((d) => eligible(d, query));
      matches.sort((a, b) => a.id.localeCompare(b.id));
      const capped = query.limit === undefined ? matches : matches.slice(0, query.limit);
      return capped.map(toToolMetadata);
    },

    schemasFor(toolIds) {
      return toolIds
        .map((id) => descriptors.get(normaliseToolId(id)))
        .filter((d): d is ToolDescriptor => d !== undefined);
    },

    counts() {
      const all = [...descriptors.values()];
      const byFamily: Record<string, number> = {};
      for (const d of all) byFamily[d.family] = (byFamily[d.family] ?? 0) + 1;
      return {
        total: all.length,
        available: all.filter((d) => d.availability === 'available').length,
        // Person 4 needs this to label the count truthfully: "18 tools (12
        // simulated)" is honest, "18 tools" is not.
        simulated: all.filter((d) => d.simulated).length,
        byFamily,
      };
    },

    clear() {
      descriptors.clear();
      schemas.clear();
    },
  };
}
