/**
 * Browserbase — cloud browser automation. LIVE ADAPTER. NOT IMPLEMENTED.
 *
 * ============================================================================
 * TO IMPLEMENT:
 *   pnpm --filter @htn/api add @browserbasehq/sdk   (2.20.0 at scaffold time)
 *   Optionally also playwright-core to drive the session over CDP.
 *
 * Needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID.
 *
 * Map onto OUR BrowserAdapter:
 *   openSession  -> create a session; return its id and the live-view URL
 *                   (the live-view URL is what makes the SwarmGrid look good —
 *                    surface it, the UI already has a slot for it)
 *   act          -> natural-language action against the page
 *   extract      -> structured extraction
 *   closeSession -> release it; sessions cost money and concurrency
 *
 * TWO THINGS TO CONFIRM AT THE BOOTH IN HOUR ONE:
 *   1. Your CONCURRENT SESSION LIMIT. The swarm design assumes you can run
 *      several at once. If the limit is low, cap fanOut concurrency to match.
 *   2. Whether session recordings are retrievable — they make free demo evidence.
 *
 * PRIVACY NOTE: this browser runs in Browserbase's cloud. Anything typed into a
 * page here has left the machine. Use it for navigation and non-sensitive work;
 * if a sensitive value must be typed, that belongs in a local browser instead.
 * ============================================================================
 */

import type { BrowserAdapter, ProviderResult } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';

function notImplemented<T>(op: string): ProviderResult<T> {
  return {
    ok: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: `browserbase.${op} live adapter is not implemented yet. See providers/browserbase/live.ts.`,
      retryable: false,
    },
    meta: { provider: 'browserbase', op, mode: 'live', latencyMs: 0, destination: null },
  };
}

export function createLiveBrowserbase(_cfg: ProviderConfig): BrowserAdapter {
  return {
    id: 'browserbase',
    mode: 'live',
    capabilities: ['browser'],
    async health() {
      return notImplemented('health');
    },
    async invoke(op) {
      return notImplemented(op);
    },
    async openSession() {
      return notImplemented('openSession');
    },
    async act() {
      return notImplemented('act');
    },
    async extract() {
      return notImplemented('extract');
    },
    async closeSession() {
      return notImplemented('closeSession');
    },
  };
}
