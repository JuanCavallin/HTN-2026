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
import { logRunEvent } from '../lib/observability.js';

export type PersistEvent = (runId: string, event: RunEvent) => Promise<StoredEvent>;
export type EventHandler = (stored: StoredEvent) => void;

export class RunBus {
  private readonly perRun = new Map<string, Set<EventHandler>>();
  private readonly global = new Set<EventHandler>();

  constructor(private readonly persist: PersistEvent) {}

  async emit(runId: string, event: RunEvent): Promise<StoredEvent> {
    const stored = await this.persist(runId, event);
    // Forwarded here because the bus is the one place every run event passes
    // through; hooking it gets the whole lifecycle from a single seam. It is a
    // no-op without SENTRY_DSN and can never throw into the emit path.
    forwardToObservability(stored);
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

/**
 * Project one run event onto a structured log.
 *
 * ONLY FIELDS THAT ARE ALREADY UI-SAFE ARE SENT. The bus also carries tool
 * arguments, model output and context summaries; none of those are included,
 * because Sentry is not a declared egress destination in the ledger and must
 * not become one by accident. Ids, statuses, counts and policy decisions
 * describe the shape of a run without carrying its content.
 */
function forwardToObservability(stored: StoredEvent): void {
  const { event, runId, seq } = stored;
  const base = { 'agentos.run_id': runId, 'agentos.seq': seq, 'agentos.event': event.type };

  switch (event.type) {
    case 'run.updated':
      logRunEvent('info', 'run ' + event.run.status, {
        ...base,
        'agentos.status': event.run.status,
      });
      return;
    case 'step.upserted':
      logRunEvent(event.step.status === 'failed' ? 'error' : 'info', 'step ' + event.step.status, {
        ...base,
        'agentos.step_id': event.step.id,
        'agentos.status': event.step.status,
        ...(event.step.error ? { 'agentos.error_code': event.step.error.code } : {}),
      });
      return;
    case 'approval.requested':
    case 'approval.resolved':
      logRunEvent('info', event.type, {
        ...base,
        'agentos.approval_id': event.approval.id,
        'agentos.status': event.approval.status,
      });
      return;
    case 'egress.logged':
      // The decision and destination, never the payload.
      logRunEvent('info', 'egress ' + event.egress.decision, {
        ...base,
        'agentos.provider': event.egress.providerId,
        'agentos.destination': event.egress.destination,
        'agentos.decision': event.egress.decision,
        'agentos.redaction_count': event.egress.dataSpans.length,
      });
      return;
    case 'pii.detected':
      // The CLASS of the detected span only. The value never leaves the machine.
      logRunEvent('warn', 'pii detected', { ...base, 'agentos.pii_type': event.span.type });
      return;
    case 'control.decided':
      logRunEvent('info', 'control ' + event.decision.operation, {
        ...base,
        'agentos.operation': event.decision.operation,
        'agentos.selected': event.decision.selectedIds.join(','),
        'agentos.confidence': event.decision.confidence,
        'agentos.source': event.decision.source,
        'agentos.reason_codes': event.decision.reasonCodes.join(','),
      });
      return;
    case 'tool.lifecycle':
      logRunEvent(
        event.lifecycle.phase === 'failed' ? 'error' : 'info',
        'tool ' + event.lifecycle.phase,
        {
          ...base,
          'agentos.tool_id': event.lifecycle.action.toolId,
          'agentos.phase': event.lifecycle.phase,
          'agentos.destination': event.lifecycle.action.destination ?? 'unknown',
          ...(event.lifecycle.error ? { 'agentos.error_code': event.lifecycle.error.code } : {}),
        },
      );
      return;
    case 'model.lifecycle':
      logRunEvent(
        event.lifecycle.phase === 'failed' ? 'error' : 'info',
        'model ' + event.lifecycle.phase,
        {
          ...base,
          'agentos.phase': event.lifecycle.phase,
          'agentos.provider': event.lifecycle.providerId,
          'agentos.route_id': event.lifecycle.routeId,
        },
      );
      return;
    case 'log':
      logRunEvent(event.level, event.message, base);
      return;
    default:
      // schedule.decided / harness.turn / session.updated carry payloads that
      // are not vetted for export; the type alone is enough for a timeline.
      logRunEvent('info', event.type, base);
  }
}
