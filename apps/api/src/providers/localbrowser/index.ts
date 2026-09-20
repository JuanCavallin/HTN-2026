/**
 * Local browser — THE PRIVACY PATH. Mock + factory.
 *
 * This is the backend that may carry `local_only` context and `secret` data,
 * because nothing it touches leaves the machine. Its destination is
 * `local://chromium`, and that string in the egress ledger is the entire proof
 * that a sensitive step did not go to Browserbase.
 *
 * Without it, every local-only step is blocked and the privacy story has a
 * hole — so the mock below is not a placeholder, it is the version of this
 * backend that runs when Chrome is not installed.
 */

import type {
  BrowserAdapter,
  BrowserOperation,
  BrowserPerformResult,
  Capability,
  ElementRow,
  ElementTable,
  ProviderCallContext,
} from '@htn/shared';
import { LOCAL_BROWSER_DESTINATION, needsTarget } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall, pick } from '../_mock.js';
import { createLiveLocalBrowser } from './live.js';

const CAPABILITIES: readonly Capability[] = ['browser.local'];

const NOTES = [
  'local record matches the reference table',
  'local ledger shows a differing amount',
  'entry present, no discrepancy',
  'no entry for this period',
] as const;

/** A small, fixed page so the mock's element table is realistic but boring. */
const MOCK_ROWS: readonly Omit<ElementRow, 'index'>[] = [
  { role: 'textbox', label: 'Search', clickable: true, editable: true, selectable: false },
  { role: 'button', label: 'Search', clickable: true, editable: false, selectable: false },
  { role: 'link', label: 'Sign in', clickable: true, editable: false, selectable: false },
  { role: 'combobox', label: 'Region', clickable: true, editable: false, selectable: true },
  { role: 'button', label: 'Accept cookies', clickable: true, editable: false, selectable: false },
];

export function create(cfg: ProviderConfig): BrowserAdapter {
  if (cfg.mode === 'live') return createLiveLocalBrowser(cfg);
  return createMock(cfg);
}

function createMock(cfg: ProviderConfig): BrowserAdapter {
  const base = mockBase('localbrowser', CAPABILITIES, cfg.mode);

  /**
   * Mirrors the live adapter's session map so a caller that leaks a session in
   * mock mode leaks one live too — a bug you want to find with no API key.
   */
  const sessions = new Map<string, { url: string; snapshotId: string }>();

  return {
    ...base,

    async openSession(input, ctx) {
      return mockCall('localbrowser', 'openSession', cfg.mode, ctx, () => {
        const sessionId = 'lb_' + Math.random().toString(36).slice(2, 10);
        sessions.set(sessionId, {
          url: input.startUrl ?? 'about:blank',
          snapshotId: 'snap_0',
        });
        // No live view: the browser is on this machine, so there is nothing to
        // stream. The UI should render "local" rather than an empty iframe.
        return { sessionId, liveViewUrl: undefined };
      });
    },

    async act(input, ctx) {
      return mockCall('localbrowser', 'act', cfg.mode, ctx, () => {
        const session = sessions.get(input.sessionId);
        const url =
          'https://example.invalid/local/' + encodeURIComponent(input.instruction.slice(0, 24));
        if (session) session.url = url;
        return { url };
      });
    },

    async extract<T = unknown>(
      input: { sessionId: string; instruction: string },
      ctx: ProviderCallContext,
    ) {
      return mockCall<T>(
        'localbrowser',
        'extract',
        cfg.mode,
        ctx,
        () => ({ note: pick(NOTES, input.instruction) }) as T,
      );
    },

    async snapshot(input, ctx) {
      return mockCall('localbrowser', 'snapshot', cfg.mode, ctx, () => {
        const session = sessions.get(input.sessionId);
        const max = input.maxElements ?? MOCK_ROWS.length;
        const rows: ElementRow[] = MOCK_ROWS.slice(0, max).map((row, i) => ({
          ...row,
          index: i + 1,
        }));
        // A new id every snapshot, exactly like live — so the freshness check
        // is exercised by the mock path rather than only discovered on stage.
        const snapshotId = 'snap_' + Math.random().toString(36).slice(2, 8);
        if (session) session.snapshotId = snapshotId;
        return {
          snapshotId,
          sessionId: input.sessionId,
          url: session?.url ?? 'about:blank',
          title: 'Mock local page',
          capturedAt: new Date().toISOString(),
          rows,
          truncated: MOCK_ROWS.length > rows.length,
          totalInteractive: MOCK_ROWS.length,
        } satisfies ElementTable;
      });
    },

    async perform(input, ctx) {
      const session = sessions.get(input.sessionId);

      // Freshness and target-shape are enforced in the mock too, so the
      // fail-closed paths are exercised with no browser installed rather than
      // discovered on stage. These are ok:false results, not throws — an
      // adapter that throws breaks the ProviderResult contract.
      const rejection = session
        ? session.snapshotId !== input.snapshotId
          ? 'stale_snapshot'
          : needsTarget(input.operation) && input.index === undefined
            ? 'wrong_operation'
            : null
        : 'unknown_index';

      if (rejection) {
        return {
          ok: false as const,
          error: {
            code: 'BAD_INPUT' as const,
            message: rejection + ': ' + input.operation + ' on ' + input.sessionId,
            retryable: rejection === 'stale_snapshot',
          },
          meta: {
            provider: 'localbrowser' as const,
            op: 'perform',
            mode: cfg.mode,
            latencyMs: 0,
            destination: 'mock://localbrowser',
          },
        };
      }

      return mockCall('localbrowser', 'perform', cfg.mode, ctx, () => {
        const navigated = input.operation === 'CLICK';
        if (session) {
          if (navigated) session.url = session.url + '#clicked';
          // CONSUME the snapshot, exactly as the live adapter does. Without
          // this the mock happily replays a stale decision and the freshness
          // guard looks like it works when it does not.
          session.snapshotId = 'consumed_' + Math.random().toString(36).slice(2, 8);
        }
        return {
          operation: input.operation as BrowserOperation,
          index: input.index,
          url: session?.url ?? 'about:blank',
          navigated,
        } satisfies BrowserPerformResult;
      });
    },

    async closeSession(sessionId, ctx) {
      return mockCall('localbrowser', 'closeSession', cfg.mode, ctx, () => {
        sessions.delete(sessionId);
        return null;
      });
    },
  };
}

export { LOCAL_BROWSER_DESTINATION };
