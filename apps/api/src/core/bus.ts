/**
 * The run event bus. THE ONLY way progress escapes the orchestrator.
 *
 * Persistence is injected as a function rather than imported, so this file stays
 * free of any store dependency and the orchestrator stays unit-testable.
 *
 * Every emit is persisted first (assigning a monotonic seq) and only then fanned
 * out to subscribers. That ordering is what makes SSE replay correct: a client
 * reconnecting with Last-Event-ID can never miss an event that a live subscriber saw.
 */

import type { RunEvent, StoredEvent } from '@htn/shared';

export type PersistEvent = (runId: string, event: RunEvent) => Promise<StoredEvent>;
export type EventHandler = (stored: StoredEvent) => void;

export class RunBus {
  private readonly perRun = new Map<string, Set<EventHandler>>();
  private readonly global = new Set<EventHandler>();

  constructor(private readonly persist: PersistEvent) {}

  async emit(runId: string, event: RunEvent): Promise<StoredEvent> {
    const stored = await this.persist(runId, event);
    for (const handler of this.perRun.get(runId) ?? []) safely(handler, stored);
    for (const handler of this.global) safely(handler, stored);
    return stored;
  }

  /** Subscribe to one run. Returns an unsubscribe function. */
  subscribe(runId: string, handler: EventHandler): () => void {
    const set = this.perRun.get(runId) ?? new Set<EventHandler>();
    set.add(handler);
    this.perRun.set(runId, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.perRun.delete(runId);
    };
  }

  /** Subscribe to every run — used by the dashboard's single global stream. */
  subscribeAll(handler: EventHandler): () => void {
    this.global.add(handler);
    return () => this.global.delete(handler);
  }

  subscriberCount(runId?: string): number {
    return runId ? (this.perRun.get(runId)?.size ?? 0) : this.global.size;
  }
}

/** A thrown subscriber must never break the run that emitted the event. */
function safely(handler: EventHandler, stored: StoredEvent): void {
  try {
    handler(stored);
  } catch (err) {
    console.error('[bus] subscriber threw:', (err as Error).message);
  }
}
