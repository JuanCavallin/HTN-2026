/**
 * Composition root. The ONLY place the layers are wired together.
 *
 * Order matters and is the reason there is no circular import:
 *   store -> bus (persists via store) -> ledger recorder (writes store + bus)
 *         -> provider registry (wrapped with that recorder)
 *         -> orchestrator (given store, bus, and the registry's accessor)
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RunBus } from '../core/bus.js';
import { buildEgressEvent } from '../core/ledger.js';
import { Orchestrator } from '../core/orchestrator.js';
import {
  createStopgapAuthorizeAction,
  createToolPlane,
  type ToolPlane,
} from '../core/tools/index.js';
import { config } from '../config.js';
import { nowIso } from '../lib/ids.js';
import { createProviderRegistry } from '../providers/registry.js';
import { createJevBrowserDecider } from '../providers/jev/browserDecider.js';
import type { RecordEgress } from '../providers/withEgress.js';
import { store } from '../store/index.js';

export const bus = new RunBus((runId, event) => store.appendEvent(runId, event));

/**
 * Every provider call lands here. Writes the ledger row, then streams it to the
 * UI so the egress table fills in live rather than only at the end.
 */
const recordEgress: RecordEgress = async (input) => {
  const event = buildEgressEvent(input, nowIso());
  await store.appendEgress(event);
  await bus.emit(event.runId, { type: 'egress.logged', egress: event });
};

export const providers = createProviderRegistry(recordEgress);

export const orchestrator = new Orchestrator({
  store,
  bus,
  provider: (capability) => providers.provider(capability),
  providerFor: (capability) => providers.bindings()[capability],
});

/* -------------------------------------------------------------------------- */
/* The tool plane (Person 3). Registry + executors, assembled once.           */
/* -------------------------------------------------------------------------- */

/**
 * Built lazily and memoised, because the Jev decider's availability is only
 * knowable asynchronously (it depends on whether the SDK resolves).
 *
 * `authorize` is 3B's STOPGAP over core/risk.ts — Person 2 owns the real
 * `authorize_action`. Swapping it is one line here and nothing else changes,
 * because every executor only ever knew the `AuthorizeAction` protocol.
 *
 * `requestApproval` is deliberately NOT passed yet: Person 1 owns pause/resume
 * and the approval endpoints, so until that is wired, an `ask_human` action is
 * DENIED rather than auto-run. Failing closed is the correct default.
 */
let toolPlanePromise: Promise<ToolPlane> | undefined;

export function toolPlane(): Promise<ToolPlane> {
  toolPlanePromise ??= (async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    return createToolPlane({
      authorize: createStopgapAuthorizeAction(),
      provider: ((capability: 'browser' | 'browser.local') =>
        providers.provider(capability)) as never,
      callContext: ({ stepId, policyRule }) => ({
        runId: 'run_tool_plane',
        ...(stepId ? { stepId } : {}),
        policyRule,
      }),
      // null when there is no TYPESAFE_API_KEY or no SDK, which is today's
      // state — the deterministic fallback then takes every decision, and
      // `decisionSource` reports that truthfully to the UI.
      jevDecider: createJevBrowserDecider(),
      descriptors: {
        localAvailable: config.providers.localbrowser.mode !== 'disabled',
        browserbaseAvailable: Boolean(config.providers.browserbase.apiKey),
      },
      pluginDirectory: join(here, '..', '..', '..', '..', 'config', 'plugins'),
    });
  })();
  return toolPlanePromise;
}

export { store };
