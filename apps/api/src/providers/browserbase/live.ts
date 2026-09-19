/**
 * Browserbase — cloud browser automation. LIVE ADAPTER via Stagehand v4.
 *
 * ============================================================================
 * WHY STAGEHAND, NOT RAW PLAYWRIGHT: our BrowserAdapter.act()/extract() methods
 * take a natural-language instruction, not a CSS selector — that shape mirrors
 * Stagehand's own act()/extract() primitives directly. Stagehand resolves the
 * instruction into real DOM actions via an LLM, which is what makes pointing
 * this at an unfamiliar portal viable mid-hackathon.
 *
 * VERIFIED AGAINST @browserbasehq/stagehand@4.1.0's own .d.ts (not docs, not
 * memory — the installed package's type declarations). Re-check this file
 * against `node_modules/@browserbasehq/stagehand/dist/index.d.mts` if the
 * installed version has moved on, since this SDK's surface changes fast:
 *
 *   const browser = await browserbase.launch({ apiKey, projectId, ... });
 *   const stagehand = await Stagehand.create({ browser, model: {...} });
 *   await stagehand.act('...');           // NOT stagehand.page.act — act/extract
 *   await stagehand.extract('...');       // live on the Stagehand instance itself
 *   await stagehand.browser.close();
 *
 * Needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID, plus an LLM key for the
 * act/extract resolution step — reusing ANTHROPIC_API_KEY below rather than
 * requiring a second one.
 *
 * SESSION LIFECYCLE mapped onto OUR BrowserAdapter:
 *   openSession   -> browserbase.launch() creates the Browserbase session;
 *                    Stagehand.create() attaches to it. stagehand.browser.sessionId
 *                    is Browserbase's real session id — the live-view URL needs a
 *                    SEPARATE call to the raw @browserbasehq/sdk's
 *                    sessions.debug(sessionId), which Stagehand does not expose.
 *   act / extract -> stagehand.act(instruction) / stagehand.extract(instruction)
 *   closeSession  -> stagehand.browser.close(). ALWAYS call this — sessions burn
 *                    concurrency and money while open.
 *
 * TWO THINGS TO CONFIRM AT THE BOOTH:
 *   1. Your CONCURRENT SESSION LIMIT — cap fanOut concurrency to match it.
 *   2. Whether session recordings are retrievable — free demo evidence.
 *
 * PRIVACY NOTE — DO NOT BREAK THIS: this browser runs in Browserbase's cloud.
 * Anything typed into a page here has left the machine. Only call this adapter
 * with policyRule values that describe non-sensitive, read-only, or already-
 * redacted work (see core/redaction.ts). If a sensitive value must be TYPED
 * into a form, that belongs in a local Playwright session instead — do not
 * route it through this adapter just because it is convenient.
 * ============================================================================
 */

import { browserbase, Stagehand, type StagehandBrowser } from '@browserbasehq/stagehand';
import type { BrowserAdapter, ProviderCallContext, ProviderResult } from '@htn/shared';
import { config, type ProviderConfig } from '../../config.js';

interface OpenSession {
  sessionId: string;
  liveViewUrl?: string;
}

interface Handle {
  stagehand: Stagehand;
  browser: StagehandBrowser;
}

function meta(op: string, started: number, destination: string | null) {
  return {
    provider: 'browserbase' as const,
    op,
    mode: 'live' as const,
    latencyMs: Date.now() - started,
    destination,
  };
}

function failure<T>(op: string, started: number, err: unknown): ProviderResult<T> {
  return {
    ok: false,
    error: { code: 'UPSTREAM', message: (err as Error).message, retryable: true },
    meta: meta(op, started, 'https://api.browserbase.com'),
  };
}

export function createLiveBrowserbase(cfg: ProviderConfig): BrowserAdapter {
  // One Stagehand instance per open session, keyed by our own sessionId so the
  // adapter's other methods can find it again.
  const sessions = new Map<string, Handle>();

  return {
    id: 'browserbase',
    mode: 'live',
    capabilities: ['browser'],

    async health() {
      const started = Date.now();
      if (!cfg.apiKey || !cfg.projectId) {
        return {
          ok: false,
          error: {
            code: 'AUTH',
            message: 'Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID',
            retryable: false,
          },
          meta: meta('health', started, null),
        };
      }
      return { ok: true, data: {}, meta: meta('health', started, 'https://api.browserbase.com') };
    },

    async invoke(op) {
      return failure(op, Date.now(), new Error('No generic invoke() op is defined for browserbase.'));
    },

    async openSession(input, _ctx: ProviderCallContext): Promise<ProviderResult<OpenSession>> {
      const started = Date.now();
      try {
        if (!cfg.apiKey || !cfg.projectId) {
          throw new Error('BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not configured');
        }

        const browser = await browserbase.launch({
          apiKey: cfg.apiKey,
          projectId: cfg.projectId,
        });

        const stagehand = await Stagehand.create({
          browser,
          model: {
            apiKey: config.providers.anthropic.apiKey,
            modelName: 'anthropic/claude-sonnet-5',
          },
        });

        if (input.startUrl) {
          await browser.context.newPage(input.startUrl);
        }

        // Our own id, not Browserbase's — keeps this adapter's sessionId format
        // opaque to callers, consistent with every other provider in this codebase.
        const sessionId = 'bb_' + Math.random().toString(36).slice(2, 10);
        sessions.set(sessionId, { stagehand, browser });

        return {
          ok: true,
          data: {
            sessionId,
            // browser.sessionId is the REAL Browserbase session id. Getting the
            // embeddable iframe URL needs one more call — the raw
            // @browserbasehq/sdk's `client.sessions.debug(browser.sessionId)` —
            // which Stagehand does not surface itself. Wire that in here once
            // you add that SDK; the UI already has a slot for the result.
            liveViewUrl: undefined,
          },
          meta: meta('openSession', started, 'https://api.browserbase.com'),
        };
      } catch (err) {
        return failure('openSession', started, err);
      }
    },

    async act(input, _ctx) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle) {
        return failure('act', started, new Error('Unknown sessionId: ' + input.sessionId));
      }
      try {
        await handle.stagehand.act(input.instruction);
        const page = await handle.browser.context.activePage();
        return {
          ok: true,
          data: { url: (await page?.url()) ?? '' },
          meta: meta('act', started, 'https://api.browserbase.com'),
        };
      } catch (err) {
        return failure('act', started, err);
      }
    },

    async extract<T = unknown>(
      input: { sessionId: string; instruction: string },
      _ctx: ProviderCallContext,
    ) {
      const started = Date.now();
      const handle = sessions.get(input.sessionId);
      if (!handle) {
        return failure<T>('extract', started, new Error('Unknown sessionId: ' + input.sessionId));
      }
      try {
        // No zod schema passed -> Stagehand returns { extraction: string }, which
        // is enough for the demo playbook's free-text note. Pass a schema as a
        // second argument for structured extraction (see the "advanced" notes).
        const result = await handle.stagehand.extract(input.instruction);
        return {
          ok: true,
          data: result.data as T,
          meta: meta('extract', started, 'https://api.browserbase.com'),
        };
      } catch (err) {
        return failure<T>('extract', started, err);
      }
    },

    async closeSession(sessionId, _ctx) {
      const started = Date.now();
      const handle = sessions.get(sessionId);
      if (!handle) return { ok: true, data: null, meta: meta('closeSession', started, null) };
      try {
        await handle.browser.close();
        sessions.delete(sessionId);
        return {
          ok: true,
          data: null,
          meta: meta('closeSession', started, 'https://api.browserbase.com'),
        };
      } catch (err) {
        return failure('closeSession', started, err);
      }
    },
  };
}
