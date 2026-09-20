/**
 * The browser family's shared vocabulary — `3B-4`'s contract.
 *
 * THE CENTRAL IDEA: a page becomes a small NUMBERED TABLE of interactive
 * elements. Jev is asked which INDEX to act on and answers `7`. The live
 * element handle for index 7 never leaves the adapter, and no CSS selector is
 * ever generated, returned, or stored.
 *
 * Why that matters beyond tidiness:
 *   - Selectors go stale between the snapshot and the click; handles do not.
 *   - An accessibility snapshot is 2-5KB where a screenshot is 100KB+, and
 *     vision tokens cost 3-5x text tokens. The table IS the request state, and
 *     state dominates a batched System One request, so keeping it small is the
 *     single biggest latency lever we control.
 *   - A model that can only return an integer into a list WE built cannot be
 *     talked by page content into issuing an action. That constrains prompt
 *     injection structurally. It does NOT replace `authorize_action`.
 *
 * ADDITIVE EDITS ONLY — published API.
 */

import type { Iso } from './domain.js';

/**
 * The operation vocabulary, matching `browser-use/jev-ultrafast`.
 *
 * `TYPE_TEXT` is the one people get wrong: Jev picks WHICH FIELD, a small
 * generative model supplies WHAT TO TYPE. Jev cannot write text.
 *
 * `DONE` / `BLOCKED` deliberately mirror the completion judge's vocabulary.
 */
export type BrowserOperation =
  'CLICK' | 'TYPE_TEXT' | 'SELECT' | 'SCROLL_UP' | 'SCROLL_DOWN' | 'WAIT' | 'DONE' | 'BLOCKED';

export const BROWSER_OPERATIONS = [
  'CLICK',
  'TYPE_TEXT',
  'SELECT',
  'SCROLL_UP',
  'SCROLL_DOWN',
  'WAIT',
  'DONE',
  'BLOCKED',
] as const satisfies readonly BrowserOperation[];

/** Operations that need a target index from the element table. */
export const TARGETED_OPERATIONS = ['CLICK', 'TYPE_TEXT', 'SELECT'] as const;

export function needsTarget(operation: BrowserOperation): boolean {
  return (TARGETED_OPERATIONS as readonly string[]).includes(operation);
}

/** One row of the table. `index` is what Jev returns. */
export interface ElementRow {
  /** 1-based. The `criteria` key handed to Jev. */
  index: number;
  /** Accessibility role: button, link, textbox, combobox, checkbox... */
  role: string;
  /** Accessible name, TRUNCATED. Long labels are the main table-size risk. */
  label: string;
  /** Current value for an input, truncated. Omitted when empty. */
  value?: string;
  /** Eligible for CLICK. */
  clickable: boolean;
  /** Eligible for TYPE_TEXT. */
  editable: boolean;
  /** Eligible for SELECT. */
  selectable: boolean;
}

/**
 * One snapshot of a page's interactive elements.
 *
 * `snapshotId` is the FRESHNESS TOKEN. An operation carries the id it was
 * decided against; if the adapter has since re-snapshotted, the operation is
 * refused rather than applied to a page that has moved underneath it. This is
 * where browser agents get flaky, so it is a hard check, not a warning.
 */
export interface ElementTable {
  snapshotId: string;
  sessionId: string;
  url: string;
  title: string;
  capturedAt: Iso;
  rows: ElementRow[];
  /** True when `totalInteractive` exceeded the cap and rows were dropped. */
  truncated: boolean;
  /** How many interactive elements the page actually had. */
  totalInteractive: number;
}

/** Outcome of applying one operation to one index. */
export interface BrowserPerformResult {
  operation: BrowserOperation;
  index?: number;
  /** URL after the operation. */
  url: string;
  /** True when the operation changed the page's document. */
  navigated: boolean;
}

/**
 * Why a chosen target was refused before execution. Both of these are normal
 * outcomes on a live page, not bugs — the caller re-snapshots and re-decides.
 */
export type TargetRejection =
  /** The page was re-snapshotted after the decision was made. */
  | 'stale_snapshot'
  /** The index is not in the table. */
  | 'unknown_index'
  /** The element is gone from the DOM. */
  | 'detached'
  /** Something (a modal, a cookie banner) is covering it. */
  | 'occluded'
  /** Present but not visible or not enabled. */
  | 'not_interactable'
  /** The operation does not apply to this element's role. */
  | 'wrong_operation';

/** The two destinations a browser step may run against. Recorded in the ledger. */
export const LOCAL_BROWSER_DESTINATION = 'local://chromium';

/**
 * Browserbase's egress host is REGION-SPECIFIC (`connect.usw2.browserbase.com`,
 * not the generic host). Approvals bind to a destination, so the per-session
 * value is what gets recorded — this constant is only the API control plane.
 */
export const BROWSERBASE_API_DESTINATION = 'https://api.browserbase.com';
