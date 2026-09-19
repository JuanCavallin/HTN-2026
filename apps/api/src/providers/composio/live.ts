/**
 * Composio — SaaS tools + OAuth brokering. LIVE ADAPTER. NOT IMPLEMENTED.
 *
 * ============================================================================
 * TO IMPLEMENT:
 *   pnpm --filter @htn/api add @composio/core        (0.18.1 at scaffold time)
 *   Needs COMPOSIO_API_KEY.
 *
 * Map onto OUR ToolboxAdapter:
 *   listTools  -> the tools available to this entity
 *   connectUrl -> the OAuth consent URL for an app; the USER opens it and grants
 *                 access themselves. Never handle their credentials here.
 *   callTool   -> execute one tool with args
 *
 * WHY THIS IS WORTH USING: hand-rolling Google/Microsoft OAuth is the single
 * largest time sink available to you this weekend. This is the thing that avoids it.
 *
 * PRIVACY NOTE: payloads routed through Composio are visible to Composio. Keep
 * low-sensitivity integrations here (calendar, notifications, the ledger sheet).
 * If a high-sensitivity payload (message bodies, documents) needs to move, connect
 * that one provider directly so the content stays local — and record the decision
 * in the egress ledger either way, so the choice is visible rather than implied.
 * ============================================================================
 */

import type { ProviderResult, ToolboxAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';

function notImplemented<T>(op: string): ProviderResult<T> {
  return {
    ok: false,
    error: {
      code: 'NOT_IMPLEMENTED',
      message: `composio.${op} live adapter is not implemented yet. See providers/composio/live.ts.`,
      retryable: false,
    },
    meta: { provider: 'composio', op, mode: 'live', latencyMs: 0, destination: null },
  };
}

export function createLiveComposio(_cfg: ProviderConfig): ToolboxAdapter {
  return {
    id: 'composio',
    mode: 'live',
    capabilities: ['toolbox'],
    async health() {
      return notImplemented('health');
    },
    async invoke(op) {
      return notImplemented(op);
    },
    async listTools() {
      return notImplemented('listTools');
    },
    async connectUrl() {
      return notImplemented('connectUrl');
    },
    async callTool() {
      return notImplemented('callTool');
    },
  };
}
