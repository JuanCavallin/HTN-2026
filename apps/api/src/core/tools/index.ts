export * from './browser.js';
export * from './browserDecision.js';
export * from './browserDescriptors.js';
export * from './composeText.js';
export * from './elementTable.js';
export * from './registry.js';

import type { BrowserAdapter } from '@htn/shared';
import { config } from '../../config.js';
import { createJevBrowserDecider } from '../../providers/jev/browserDecider.js';
import { createBrowserExecutor } from './browser.js';
import type { BrowserToolExecutor } from './browser.js';
import {
  createDeterministicDecider,
  createResolutionCache,
  withFallback,
  withResolutionCache,
} from './browserDecision.js';
import { browserToolRegistrations } from './browserDescriptors.js';
import type { InMemoryToolExecutorRegistry } from './executors.js';
import type { InMemoryToolRegistry } from './registry.js';

export interface RegisterBrowserToolsOptions {
  provider(capability: 'browser' | 'browser.local'): BrowserAdapter;
}

/** Register the teammate browser adapters inside AgentOS's trusted broker. */
export function registerBrowserTools(
  registry: InMemoryToolRegistry,
  executors: InMemoryToolExecutorRegistry,
  options: RegisterBrowserToolsOptions,
): BrowserToolExecutor {
  registry.registerMany(
    browserToolRegistrations({
      // AVAILABLE MEANS "THIS BACKEND CAN SERVE A CALL", NOT "THIS BACKEND IS
      // LIVE". A mocked adapter serves calls perfectly well -- that is the
      // entire point of mock mode, and the README promises the full demo runs
      // with no API keys at all.
      //
      // Requiring 'live' here made every browser tool `unavailable` under
      // MOCK_ALL, and `eligibleTaskTools` drops unavailable tools, so an
      // agent_task silently received an EMPTY toolset and the harness fell
      // back to its own browser. Only 'disabled' means a backend cannot serve.
      //
      // Truthfulness is preserved elsewhere and not weakened here: withEgress
      // records a mocked call against a `mock://` destination, and the provider
      // badges report the mode, so nothing presents a mock as a live call.
      localAvailable: config.providers.localbrowser.mode !== 'disabled',
      browserbaseAvailable: config.providers.browserbase.mode !== 'disabled',
    }),
  );

  const deterministic = createDeterministicDecider();
  const jev = createJevBrowserDecider();
  const decider = withResolutionCache(
    jev
      ? withFallback(jev, deterministic, (error) =>
          console.warn(
            '[browser] Jev target selection failed; using deterministic fallback: ' +
              (error instanceof Error ? error.message : String(error)),
          ),
        )
      : deterministic,
    createResolutionCache(),
  );

  const executor = createBrowserExecutor({
    provider: options.provider,
    decide: decider,
    maxElements: config.browser.maxElements,
  });
  executors.register(executor);
  return executor;
}
