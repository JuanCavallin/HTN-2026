/**
 * Composition root. The ONLY place the layers are wired together.
 *
 * Order matters and is the reason there is no circular import:
 *   store -> bus (persists via store) -> ledger recorder (writes store + bus)
 *         -> provider registry (wrapped with that recorder)
 *         -> orchestrator (given store, bus, and the registry's accessor)
 */

import { RunBus } from '../core/bus.js';
import { buildEgressEvent } from '../core/ledger.js';
import { Orchestrator } from '../core/orchestrator.js';
import { nowIso } from '../lib/ids.js';
import { createProviderRegistry } from '../providers/registry.js';
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
});

export { store };
