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
      localAvailable: config.providers.localbrowser.mode === 'live',
      browserbaseAvailable: config.providers.browserbase.mode === 'live',
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
