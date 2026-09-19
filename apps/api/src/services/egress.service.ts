import type { EgressEvent } from '@htn/shared';
import { summarise } from '../core/ledger.js';
import { store } from './runtime.js';

export async function listEgress(runId: string): Promise<{
  events: EgressEvent[];
  summary: ReturnType<typeof summarise>;
}> {
  const events = await store.listEgress(runId);
  return { events, summary: summarise(events) };
}
