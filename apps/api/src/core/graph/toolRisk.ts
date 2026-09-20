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
 * TODO(person-3): DELETE THIS TABLE.
 *
 * implementation_plan.md M1 already assigns "implement common tool interface
 * and read/write classification" to the tool registry. Once ToolCatalogEntry
 * carries that classification, this file becomes a lookup against the registry
 * and the hardcoded map goes away. Full handoff, including every other place
 * that has to match: docs/tool-registry-handoff.md
 * ============================================================================
 */

/** Tool name -> ProposedAction.kind, in core/risk.ts's vocabulary. */
const TOOL_ACTION_KIND: Record<string, string> = {
  // Reads. Reversible, run automatically.
  'browser.navigate': 'read_page',
  'browser.extract': 'read_page',
  'web.search': 'read_page',
  'docs.read': 'read_page',

  // Recoverable: undoable, but only by a human or a support path.
  'sheets.append': 'update_profile',
  'calendar.create': 'schedule',
  'docs.draft': 'create_draft',

  // Irreversible. These always stop for a human.
  'forms.submit': 'submit_form',
  'mail.send': 'send_email',
  'notify.slack': 'send_message',
  'notify.sms': 'send_message',
  'payments.charge': 'make_payment',
};

/** Used when a tool is not in the table. Classifies as ask_human. */
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
  const known = TOOL_ACTION_KIND[tool];
  if (known) return { kind: known, unknown: false };
  return { kind: UNKNOWN_TOOL_ACTION_KIND, unknown: true };
}

/** Every tool this table can classify. Handy for seeding demo graphs. */
export function classifiedTools(): string[] {
  return Object.keys(TOOL_ACTION_KIND);
}
