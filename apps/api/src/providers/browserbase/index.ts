import type { BrowserAdapter, Capability, ProviderCallContext } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall, pick } from '../_mock.js';
import { createLiveBrowserbase } from './live.js';

const CAPABILITIES: readonly Capability[] = ['browser'];

const NOTES = [
  'line item matches the reference table',
  'amount differs from the published rate',
  'record present, no discrepancy',
  'entry missing for this period',
] as const;

export function create(cfg: ProviderConfig): BrowserAdapter {
  if (cfg.mode === 'live') return createLiveBrowserbase(cfg);
  return createMock(cfg);
}

function createMock(cfg: ProviderConfig): BrowserAdapter {
  const base = mockBase('browserbase', CAPABILITIES, cfg.mode);
  return {
    ...base,
    async openSession(input, ctx) {
      return mockCall('browserbase', 'openSession', cfg.mode, ctx, () => {
        const sessionId = 'bb_' + Math.random().toString(36).slice(2, 10);
        return {
          sessionId,
          // The real adapter returns a live-view URL here; the UI already renders it.
          liveViewUrl: undefined,
          startUrl: input.startUrl,
        } as { sessionId: string; liveViewUrl?: string };
      });
    },
    async act(input, ctx) {
      return mockCall('browserbase', 'act', cfg.mode, ctx, () => ({
        url: 'https://example.invalid/mock/' + encodeURIComponent(input.instruction.slice(0, 24)),
      }));
    },
    async extract<T = unknown>(
      input: { sessionId: string; instruction: string },
      ctx: ProviderCallContext,
    ) {
      return mockCall<T>(
        'browserbase',
        'extract',
        cfg.mode,
        ctx,
        () => ({ note: pick(NOTES, input.instruction) }) as T,
      );
    },
    async closeSession(_sessionId, ctx) {
      return mockCall('browserbase', 'closeSession', cfg.mode, ctx, () => null);
    },
  };
}
