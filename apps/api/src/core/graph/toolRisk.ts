/**
 * What does calling this tool actually DO?
 *
 * core/risk.ts classifies a ProposedAction by its `kind`, and that is what
 * decides whether a human gets asked. A hand-written playbook supplies the kind
 * literally (demo.playbook.ts passes 'submit_form'). A GRAPH cannot: a `tool`
 * node names a tool, and a `dispatch` node does not even know which tool until
 * a model has picked one.
 *
 * So the tool name has to map to an action kind, and getting that wrong in the
 * permissive direction is the worst bug available here — it would let a
 * model-selected `mail.send` run unattended and turn `dispatch` into a way
 * around the approval gate.
 *
 * Hence: UNKNOWN TOOLS FAIL CLOSED. An unrecognised tool is treated as
 * irreversible and stops for a human. That is noisy by design; the fix is to
 * classify the tool, not to loosen the default.
 *
 * ============================================================================
 * DONE(person-3): the table is gone. This is now a lookup against the catalog.
 *
 * `ToolCatalogEntry.actionKind` carries the classification, so the mapping
 * lives with the tool as the handoff asked. What is deliberately UNCHANGED:
 *
 *   - `explicit` still wins. A graph author who names the kind knows more than
 *     the catalog does.
 *   - An unclassified tool still FAILS CLOSED. A tool absent from the catalog,
 *     or present with no `actionKind`, is treated as irreversible and stops for
 *     a human. Noisy by design; the fix is to classify the tool, not to loosen
 *     the default.
 *
 * The catalog is injected rather than imported so this file stays pure — core
 * does not reach into providers. `services/runtime.ts` supplies it once at
 * startup; until it does, the lookup is empty and EVERYTHING stops for a human,
 * which is the safe direction to be wrong in.
 * ============================================================================
 */

/**
 * Tool name -> action kind, populated from the catalog at startup.
 *
 * Empty until `setToolClassifications` runs. An empty index means every tool is
 * unclassified, which means every tool stops for a human — loud, and safe.
 */
let CLASSIFICATIONS: ReadonlyMap<string, string> = new Map();

/**
 * Tool name -> its one-line description, from the same catalog read.
 *
 * Only `dispatch`'s `argsFrom: 'model'` path uses it: to infer a chosen tool's
 * arguments, the model has to be told what that tool takes, and the catalog is
 * the one place that says so. Empty is a normal state -- see `toolDescription`.
 */
let DESCRIPTIONS: ReadonlyMap<string, string> = new Map();

/** Called once at startup with whatever the catalog reports. */
export function setToolClassifications(
  entries: readonly { name: string; description?: string; actionKind?: string }[],
): void {
  const next = new Map<string, string>();
  const described = new Map<string, string>();
  for (const entry of entries) {
    if (entry.actionKind) next.set(entry.name, entry.actionKind);
    if (entry.description) described.set(entry.name, entry.description);
  }
  CLASSIFICATIONS = next;
  DESCRIPTIONS = described;
}

/**
 * What a tool does and what it takes, or '' when the catalog never mentioned it.
 *
 * Unlike a missing CLASSIFICATION, a missing description is not a safety
 * matter: it makes an inferred-args prompt weaker, not a call more permissive.
 */
export function toolDescription(tool: string): string {
  return DESCRIPTIONS.get(tool) ?? '';
}

export const UNKNOWN_TOOL_ACTION_KIND = 'unclassified_tool';

export interface ToolRisk {
  kind: string;
  /** True when we had to guess. The interpreter logs a warning and gates it. */
  unknown: boolean;
}

/**
 * `explicit` is the node's own `actionKind`, which always wins — a graph author
 * who names the kind has told us more than the table knows.
 */
export function toolRisk(tool: string, explicit?: string): ToolRisk {
  if (explicit) return { kind: explicit, unknown: false };
  const known = CLASSIFICATIONS.get(tool);
  if (known) return { kind: known, unknown: false };
  return { kind: UNKNOWN_TOOL_ACTION_KIND, unknown: true };
}

/** Every tool the catalog can classify. Handy for seeding demo graphs. */
export function classifiedTools(): string[] {
  return [...CLASSIFICATIONS.keys()];
}
