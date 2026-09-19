/**
 * Hermes Agent (Nous Research) — LIVE ADAPTER. NOT IMPLEMENTED.
 *
 * ============================================================================
 * READ THIS BEFORE WRITING CODE HERE.
 *
 * The real endpoints, auth scheme, and payload shapes for Hermes are NOT known
 * to whoever scaffolded this file, and were deliberately NOT guessed. Inventing
 * them would produce code that compiles, looks finished, and fails at the booth.
 *
 * ARCHITECTURE DECISION ALREADY MADE: Hermes owns its own tool-calling loop.
 * We do NOT intercept it turn by turn — we call Jev's route() ONCE before
 * starting a subtask to pick a model tier and filter the tool list, then hand
 * Hermes that filtered list and let it run autonomously until done (see
 * core/orchestrator.ts's runAgentTask). This works with the shape below as
 * long as startTask's `tools` field is honoured as an allowlist.
 *
 * TO IMPLEMENT — go to the sponsor's docs or their table, then fill in, IN
 * THIS ORDER OF IMPORTANCE:
 *   1. Does startTask's tool list actually RESTRICT what Hermes can call, or
 *      is every registered tool always available regardless of what's passed?
 *      If the latter, the tool-filtering mechanic does not work as designed
 *      through this API and needs a different approach (e.g. registering
 *      distinct tool sets per session instead of per call) — confirm this
 *      BEFORE building anything downstream of it.
 *   2. Does pollTask (or an equivalent status/trace endpoint) report which
 *      tools/actions Hermes actually invoked internally? Our `toolCalls` field
 *      below depends on this. If it isn't available, every call Hermes makes
 *      internally is invisible to our egress ledger — a real gap in the
 *      privacy/audit story, not a cosmetic one. Say so rather than leaving it
 *      silently empty.
 *   3. Base URL                 -> HERMES_BASE_URL
 *   4. Auth header shape        -> Authorization: Bearer? X-API-Key? something else?
 *   5. Start a task             -> map to startTask({ goal, context, tools })
 *   6. Poll / stream a task     -> map to pollTask(taskId)
 *   7. Cancel a task            -> map to cancelTask(taskId)
 *
 * Map THEIR shapes onto OUR AgentRuntimeAdapter interface. Do not let their types
 * leak past this file — that is the whole point of the adapter.
 *
 * SAFETY RULE — do not violate this when wiring the real thing: any tool
 * classified irreversible must never appear in the `tools` list handed to
 * startTask for unattended execution. Hermes proposes; our own orchestrator,
 * outside Hermes's loop, performs the irreversible call after our existing
 * approval gate. Filter irreversible tools out at the call site that builds
 * the `availableTools` list, before it ever reaches route() or startTask.
 *
 * Until then: HERMES_MODE=mock (the default) and everything works.
 * ============================================================================
 */

import type { AgentRuntimeAdapter, ProviderResult } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';

function notImplemented<T>(op: string): ProviderResult<T> {
  return {
    ok: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: `hermes.${op} live adapter is not implemented yet. See providers/hermes/live.ts.`,
      retryable: false,
    },
    meta: { provider: 'hermes', op, mode: 'live', latencyMs: 0, destination: null },
  };
}

export function createLiveHermes(_cfg: ProviderConfig): AgentRuntimeAdapter {
  return {
    id: 'hermes',
    mode: 'live',
    capabilities: ['agent.runtime'],
    async health() {
      return notImplemented('health');
    },
    async invoke(op) {
      return notImplemented(op);
    },
    async startTask() {
      return notImplemented('startTask');
    },
    async pollTask() {
      return notImplemented('pollTask');
    },
    async cancelTask() {
      return notImplemented('cancelTask');
    },
  };
}
