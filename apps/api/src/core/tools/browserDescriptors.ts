/**
 * The browser family's descriptors — seam 4 (3B registers into 3A's registry).
 *
 * ============================================================================
 * THE BROWSERBASE PRIVACY RULE IS ENCODED HERE, IN THE DESCRIPTOR, and that is
 * the whole point of this file.
 *
 * Browserbase is a remote data recipient. Anything typed into a page there has
 * left the machine — inputs, screenshots and cookies alike. So every
 * Browserbase descriptor omits `local_only` from `allowedContextScopes` and
 * `secret` from `allowedDataLabels`.
 *
 * Encoding it in the descriptor rather than in a runtime check matters: the
 * registry filters on availability and labels BEFORE selection, so a local-only
 * step never sees a Browserbase tool as a candidate at all. A runtime check is
 * something a future caller can forget to run; a descriptor that was never
 * eligible is not.
 * ============================================================================
 */

import type { ToolDescriptor } from '@htn/shared';
import { BROWSER_FAMILY } from '@htn/shared';
import { BROWSER_EXECUTOR_REF } from './browser.js';

const VERSION = '1.0.0';

interface OperationSpec {
  operation: string;
  description: string;
  riskClass: ToolDescriptor['riskClass'];
}

const OPERATIONS: readonly OperationSpec[] = [
  {
    operation: 'open',
    description: 'Open a browser session, optionally at a starting URL.',
    riskClass: 'auto',
  },
  {
    operation: 'search',
    description: 'Run a search and return the result text.',
    riskClass: 'auto',
  },
  { operation: 'extract', description: 'Extract text from the current page.', riskClass: 'auto' },
  {
    operation: 'inspect',
    description: 'Return the indexed table of interactive elements on the page.',
    riskClass: 'auto',
  },
  {
    operation: 'click',
    description: 'Click the element that best matches the goal.',
    riskClass: 'verify',
  },
  {
    operation: 'type',
    description: 'Type a value into the field that best matches the goal.',
    riskClass: 'verify',
  },
  {
    // Irreversible by construction — a submitted form cannot be unsubmitted.
    // core/risk.ts classifies `submit_form` the same way; this is not a
    // second opinion, it is the same rule written where selection can see it.
    operation: 'submit',
    description: 'Submit a form. Irreversible: always requires human approval.',
    riskClass: 'ask_human',
  },
  { operation: 'close', description: 'Release the browser session.', riskClass: 'auto' },
];

function build(
  providerId: 'localbrowser' | 'browserbase',
  allowedDataLabels: ToolDescriptor['allowedDataLabels'],
  allowedContextScopes: ToolDescriptor['allowedContextScopes'],
  availability: ToolDescriptor['availability'],
): ToolDescriptor[] {
  return OPERATIONS.map((spec) => ({
    id: providerId + '.' + spec.operation,
    providerId,
    family: BROWSER_FAMILY,
    description: spec.description,
    schemaRef: 'schema:' + providerId + '.' + spec.operation + '@1',
    transport: 'native',
    riskClass: spec.riskClass,
    requiredScopes: [],
    allowedDataLabels,
    allowedContextScopes,
    availability,
    executorRef: BROWSER_EXECUTOR_REF,
    version: VERSION,
    simulated: false,
    ...(providerId === 'browserbase' ? { credentialRef: 'BROWSERBASE_API_KEY' } : {}),
  }));
}

export interface BrowserDescriptorOptions {
  /** False when LOCALBROWSER_CHANNEL is unset and the backend is mocked. */
  localAvailable?: boolean;
  /** False when Browserbase credentials are missing. */
  browserbaseAvailable?: boolean;
}

export function browserDescriptors(options: BrowserDescriptorOptions = {}): ToolDescriptor[] {
  return [
    // LOCAL: the privacy path. The only browser destination that may carry
    // local-only context or secret data, because nothing it touches leaves.
    ...build(
      'localbrowser',
      ['public', 'private', 'secret'],
      ['public', 'private', 'local_only'],
      options.localAvailable === false ? 'unavailable' : 'available',
    ),

    // REMOTE: no `secret`, no `local_only`. See this file's header.
    ...build(
      'browserbase',
      ['public', 'private'],
      ['public', 'private'],
      options.browserbaseAvailable === false ? 'unauthenticated' : 'available',
    ),
  ];
}

/**
 * The invariant this module exists to guarantee, written as a check so it can
 * be asserted rather than reviewed. Used by the browser check script.
 */
export function browserbaseDescriptorsAreSafe(descriptors: readonly ToolDescriptor[]): boolean {
  return descriptors
    .filter((d) => d.providerId === 'browserbase')
    .every(
      (d) =>
        !d.allowedContextScopes.includes('local_only') && !d.allowedDataLabels.includes('secret'),
    );
}
