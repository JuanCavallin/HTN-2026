/**
 * Shaping an `ElementTable` into what Jev actually consumes — `3B-4`.
 *
 * Pure. No provider, no fetch, no store. The adapter captures the table and
 * owns the handles; this file only decides how it is WORDED and which indices
 * are offered per operation.
 *
 * WHY THIS IS THE LATENCY LEVER: a System One request is dominated by its
 * `state`, and for a browser step the state IS this table. TypeSafe's own
 * benchmark put 13 questions over a ~54k-character document at one call /
 * 0.31s / $0.0012 versus 13 calls / 2.95s / $0.0139 — the batching win comes
 * precisely from not re-sending the state. So the table is trimmed hard:
 * interactive elements only, truncated labels, a row cap.
 *
 * WHY INTEGER KEYS: Jev returns one key from a `criteria` object we built. An
 * integer index means the answer cannot be a selector, cannot be a URL, and
 * cannot be anything the page talked it into — it is an index into a list this
 * process constructed. That constrains injection structurally. It is not a
 * substitute for the gate.
 */

import type { BrowserOperation, ElementRow, ElementTable } from '@htn/shared';

/** Which rows may serve as a target for a given operation. */
export function eligibleRows(table: ElementTable, operation: BrowserOperation): ElementRow[] {
  switch (operation) {
    case 'CLICK':
      return table.rows.filter((r) => r.clickable);
    case 'TYPE_TEXT':
      return table.rows.filter((r) => r.editable);
    case 'SELECT':
      return table.rows.filter((r) => r.selectable);
    default:
      return [];
  }
}

/** `[1] button  Sign in` — the one-line form a human reads in the trace. */
export function renderRow(row: ElementRow): string {
  const value = row.value ? ' · ' + row.value : '';
  return '[' + row.index + '] ' + row.role.padEnd(9) + ' ' + row.label + value;
}

export function renderTable(table: ElementTable): string {
  const lines = table.rows.map(renderRow);
  if (table.truncated) {
    lines.push(
      '… ' + (table.totalInteractive - table.rows.length) + ' more interactive element(s)',
    );
  }
  return lines.join('\n');
}

/**
 * The `criteria` object for one `choice` question: integer keys, short
 * descriptions. Returns `null` when no row is eligible — a choice question with
 * fewer than two options is not a question, and asking one is an error.
 */
export function toCriteria(rows: readonly ElementRow[]): Record<string, string> | null {
  if (rows.length === 0) return null;
  const criteria: Record<string, string> = {};
  for (const row of rows) criteria[String(row.index)] = renderRow(row);
  return criteria;
}

/**
 * The `state` handed to System One. Deliberately small and deliberately NOT the
 * DOM: an accessibility-shaped table is 80-90% smaller than raw DOM, and a
 * screenshot would cost 3-5x per token on top of being 20-50x larger.
 */
export interface BrowserState {
  goal: string;
  url: string;
  title: string;
  page: string;
  /** Only when a page hid rows — Jev should know the list is not exhaustive. */
  truncatedNote?: string;
}

export function toState(table: ElementTable, goal: string): BrowserState {
  return {
    goal,
    url: table.url,
    title: table.title,
    page: renderTable(table),
    ...(table.truncated
      ? {
          truncatedNote:
            'Only the first ' +
            table.rows.length +
            ' of ' +
            table.totalInteractive +
            ' interactive elements are listed. SCROLL_DOWN to see more.',
        }
      : {}),
  };
}

/**
 * Stable identity for a row, used as the resolution cache key's value.
 *
 * Deliberately NOT the index: indices shift when a page adds a banner, so a
 * cached index is wrong on the second run in exactly the way that makes a
 * rehearsed demo fail. Role + label survives that, and re-resolving it against
 * the current table costs nothing and needs no model call.
 */
export function rowIdentity(row: ElementRow): string {
  return row.role + '\u0000' + row.label.toLowerCase();
}

export function findByIdentity(table: ElementTable, identity: string): ElementRow | undefined {
  return table.rows.find((row) => rowIdentity(row) === identity);
}
