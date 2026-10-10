/**
 * Sentry wiring — tracing and structured logs over the control plane.
 *
 * ============================================================================
 * WHY A CONTROL PLANE IS THE RIGHT THING TO INSTRUMENT.
 *
 * AgentOS already measures every number Sentry wants: per-provider latency,
 * tokens, estimated cost, the destination a call went to, and the policy rule
 * that permitted it. What it lacked was somewhere to correlate them. A run is a
 * distributed operation — dashboard -> outer controller -> Hermes -> model
 * gateway -> provider -> tool broker -> executor — and until now the only way
 * to see it end to end was the SSE trace in our own UI, which is gone the
 * moment the tab closes.
 *
 * Three products are used, which is what makes this more than an SDK install:
 *
 *   TRACING   one span per outbound provider call, wrapped around the SAME
 *             proxy that writes the egress ledger (withEgress). A provider call
 *             that is not traced is therefore not reachable, for the same
 *             structural reason an unlogged one is not.
 *   LOGS      every RunEvent, forwarded from the bus. The bus is documented as
 *             "THE ONLY way progress escapes the orchestrator", so hooking it
 *             gets the whole lifecycle from one seam rather than N call sites.
 *   ERRORS    unhandled failures, via the Express error handler.
 * ---------------------------------------------------------------------------
 * IT IS OFF UNLESS SENTRY_DSN IS SET, AND THAT IS LOAD-BEARING.
 *
 * The repo's standing invariant is that a fresh clone with no .env and no keys
 * boots and runs the full demo. So every function here is a no-op without a
 * DSN, none of them throw, and none of them are on the critical path of a run:
 * a Sentry outage must never be able to fail a step. `enabled` is checked
 * rather than relying on the SDK's own disabled state so the intent is local.
 * ---------------------------------------------------------------------------
 * WHAT MUST NEVER BE SENT.
 *
 * Spans carry the SHAPE of a call, never its payload: provider, op, destination,
 * latency, tokens, cost, policy rule, and the CLASS of any redacted span
 * (`pii.email`), never the value. That mirrors the egress ledger's own rule —
 * it records what class of data left, never the data. Sending a prompt or a
 * tool argument to Sentry would make Sentry an undeclared egress destination
 * that the ledger does not know about, which would quietly break the privacy
 * claim this product is built on. `sendDefaultPii` is therefore off, and there
 * is deliberately no helper here that takes free text.
 * ============================================================================
 */

import * as Sentry from '@sentry/node';
import type { EgressInput } from '../core/ledger.js';

let enabled = false;

export function initObservability(options: {
  dsn?: string;
  environment: string;
  tracesSampleRate: number;
  release?: string;
}): boolean {
  if (!options.dsn) return false;

  try {
    Sentry.init({
      dsn: options.dsn,
      environment: options.environment,
      release: options.release,
      tracesSampleRate: options.tracesSampleRate,
      // Structured logs (Sentry Logs), the second product beyond errors.
      enableLogs: true,
      // Never attach IPs, headers, cookies or bodies. See the note above.
      sendDefaultPii: false,
    });
    enabled = true;
    console.log('[sentry] tracing + logs enabled (' + options.environment + ')');
  } catch (error) {
    // Observability must never be able to stop the API from booting.
    console.warn(
      '[sentry] init failed, continuing without it:',
      error instanceof Error ? error.message : 'unknown error',
    );
    enabled = false;
  }
  return enabled;
}

export function observabilityEnabled(): boolean {
  return enabled;
}

/**
 * Wrap one outbound provider call in a span.
 *
 * Returns the callback's result untouched, and never swallows or delays its
 * error — the span records the failure and rethrows, so instrumenting a call
 * cannot change what the caller sees.
 */
export async function traceProviderCall<T>(
  input: { providerId: string; op: string; runId: string; stepId?: string },
  run: () => Promise<T>,
): Promise<T> {
  if (!enabled) return run();

  return Sentry.startSpan(
    {
      name: input.providerId + '.' + input.op,
      op: 'gen_ai.provider',
      attributes: {
        'agentos.provider': input.providerId,
        'agentos.op': input.op,
        'agentos.run_id': input.runId,
        ...(input.stepId ? { 'agentos.step_id': input.stepId } : {}),
      },
    },
    run,
  );
}

/**
 * Attach the ledger row's measurements to the active provider span.
 *
 * Called from the same place the ledger row is written, so the span and the
 * ledger can never disagree about what a call cost or where it went.
 */
export function annotateEgress(input: EgressInput): void {
  if (!enabled) return;
  const span = Sentry.getActiveSpan();
  if (!span) return;

  span.setAttributes({
    'agentos.destination': input.destination ?? 'mock',
    'agentos.policy_rule': input.policyRule,
    'agentos.blocked': input.blocked ?? false,
    ...(input.latencyMs !== undefined ? { 'agentos.latency_ms': input.latencyMs } : {}),
    ...(input.tokensIn !== undefined ? { 'gen_ai.usage.input_tokens': input.tokensIn } : {}),
    ...(input.tokensOut !== undefined ? { 'gen_ai.usage.output_tokens': input.tokensOut } : {}),
    ...(input.estimatedCostCents !== undefined
      ? { 'agentos.cost_cents': input.estimatedCostCents }
      : {}),
    // The CLASS of redacted data only. Never the value — see the header.
    ...(input.dataSpans && input.dataSpans.length > 0
      ? {
          'agentos.redaction_count': input.dataSpans.length,
          'agentos.redaction_types': [...new Set(input.dataSpans.map((span) => span.type))].join(
            ',',
          ),
        }
      : {}),
  });
}

/**
 * Forward one run event as a structured log.
 *
 * `detail` is built by the caller from event fields that are already UI-safe,
 * because the bus carries some payloads (tool arguments, output summaries) that
 * are not. Keeping the projection at the call site rather than here means the
 * decision about what is safe to send is made where the event type is known.
 */
export function logRunEvent(
  level: 'info' | 'warn' | 'error',
  message: string,
  attributes: Record<string, string | number | boolean>,
): void {
  if (!enabled) return;
  try {
    Sentry.logger[level](message, attributes);
  } catch {
    // A logging failure is never worth failing a run over.
  }
}

export function captureError(error: unknown, context?: Record<string, string>): void {
  if (!enabled) return;
  try {
    Sentry.captureException(error, context ? { tags: context } : undefined);
  } catch {
    /* see above */
  }
}

/** Flush buffered events on shutdown; a killed process otherwise loses the tail. */
export async function flushObservability(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    /* shutdown must not block on Sentry */
  }
}
