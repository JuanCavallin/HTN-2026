/**
 * The tool plane, assembled. One call builds the registry, loads the manifests,
 * registers the browser family, and binds the executors.
 *
 * This is where 3A and 3B meet: the browser is ONE FAMILY INSIDE 3A's REGISTRY,
 * not a parallel system. 3B supplies descriptors and an executor; 3A owns the
 * registry, selection, and the rule that every executor calls the gate.
 */

export * from './authorize.js';
export * from './browser.js';
export * from './browserDecision.js';
export * from './browserDescriptors.js';
export * from './elementTable.js';
export * from './executor.js';
export * from './manifest.js';
export * from './manifestLoader.js';
export * from './mcp.js';
export * from './registry.js';

import type { AuthorizeAction, ToolExecutor } from '@htn/shared';
import { createBrowserExecutor, type BrowserExecutorDeps } from './browser.js';
import {
  createDeterministicDecider,
  createResolutionCache,
  withResolutionCache,
  type BrowserDecider,
  type ResolutionCache,
} from './browserDecision.js';
import { browserDescriptors, type BrowserDescriptorOptions } from './browserDescriptors.js';
import { createToolDispatcher } from './executor.js';
import { loadPluginManifests, type LoadedPlugins } from './manifestLoader.js';
import { createToolRegistry, type ToolRegistry } from './registry.js';

export interface ToolPlaneOptions {
  authorize: AuthorizeAction;
  provider: BrowserExecutorDeps['provider'];
  callContext: BrowserExecutorDeps['callContext'];
  composeText?: BrowserExecutorDeps['composeText'];
  /**
   * The Jev-backed decider, when one could be built. `null` means no key or no
   * SDK, and the deterministic fallback takes over — which is the normal state
   * today and keeps the whole demo runnable with zero credentials.
   */
  jevDecider?: BrowserDecider | null;
  descriptors?: BrowserDescriptorOptions;
  selectedTools?: (stepId: string) => readonly string[] | undefined;
  /** Absolute path to config/plugins/. Omitted means "do not load manifests". */
  pluginDirectory?: string;
}

export interface ToolPlane {
  registry: ToolRegistry;
  /** Call this. It is the dispatcher, and it enforces the four blocks. */
  executor: ToolExecutor;
  /** Exposed so a warm-up run can be proved to have populated it. */
  cache: ResolutionCache;
  decider: BrowserDecider;
  plugins: LoadedPlugins;
  /** Truthful labeling: what the browser decisions actually came from. */
  decisionSource: 'jev' | 'deterministic';
}

export async function createToolPlane(options: ToolPlaneOptions): Promise<ToolPlane> {
  const registry = createToolRegistry();

  // 3B registers into 3A's registry. No second catalog.
  registry.registerAll(browserDescriptors(options.descriptors));

  const plugins = options.pluginDirectory
    ? await loadPluginManifests(options.pluginDirectory)
    : { descriptors: [], loaded: [], skipped: [] };
  registry.registerAll(plugins.descriptors);

  const cache = createResolutionCache();
  const base = options.jevDecider ?? createDeterministicDecider();
  const decider = withResolutionCache(base, cache);

  const browserExecutor = createBrowserExecutor({
    provider: options.provider,
    authorize: options.authorize,
    decide: decider,
    callContext: options.callContext,
    ...(options.composeText ? { composeText: options.composeText } : {}),
  });

  return {
    registry,
    executor: createToolDispatcher({
      registry,
      executors: [browserExecutor],
      ...(options.selectedTools ? { selectedTools: options.selectedTools } : {}),
    }),
    cache,
    decider,
    plugins,
    decisionSource: options.jevDecider ? 'jev' : 'deterministic',
  };
}
