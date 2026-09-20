/**
 * Composition root. The ONLY place the layers are wired together.
 *
 * Order matters and is the reason there is no circular import:
 *   store -> bus (persists via store) -> ledger recorder (writes store + bus)
 *         -> provider registry (wrapped with that recorder)
 *         -> orchestrator (given store, bus, and the registry's accessor)
 */

import { RunBus } from '../core/bus.js';
import { isTerminal } from '@htn/shared';
import { config } from '../config.js';
import { buildEgressEvent } from '../core/ledger.js';
import { Orchestrator } from '../core/orchestrator.js';
import { DecisionService } from '../core/decisions/service.js';
import { modelRoutesFor } from '../core/modelGateway/catalog.js';
import { ModelGatewayService, textAdapterBackend } from '../core/modelGateway/service.js';
import { RunToolApprovalGate } from '../core/tools/approval.js';
import { ToolBroker } from '../core/tools/broker.js';
import { InMemoryToolExecutorRegistry } from '../core/tools/executors.js';
import { InMemoryToolRegistry } from '../core/tools/registry.js';
import { registerCoreLocalTools } from '../core/tools/local.js';
import { registerBrowserTools } from '../core/tools/index.js';
import { SessionStateService } from '../core/sessions/service.js';
import { nowIso } from '../lib/ids.js';
import { createProviderRegistry } from '../providers/registry.js';
import { createOpenRouterBackend, openRouterModelRoutes } from '../providers/openrouter/backend.js';
import { createOllamaBackend, ollamaModelRoutes } from '../providers/ollama/backend.js';
import type { RecordEgress } from '../providers/withEgress.js';
import { ComposioToolCatalog } from '../providers/composio/register.js';
import { McpConnectionManager } from '../core/mcp/connections.js';
import { store } from '../store/index.js';

export const bus = new RunBus((runId, event) => store.appendEvent(runId, event));

/**
 * Every provider call lands here. Writes the ledger row, then streams it to the
 * UI so the egress table fills in live rather than only at the end.
 */
const recordEgress: RecordEgress = async (input) => {
  const event = buildEgressEvent(input, nowIso());
  await store.appendEgress(event);
  await bus.emit(event.runId, { type: 'egress.logged', egress: event });
};

export const providers = createProviderRegistry(recordEgress);
export const decisionService = new DecisionService(providers.provider('decision'));
export const sessionStateService = new SessionStateService(store, bus);
export const toolRegistry = new InMemoryToolRegistry();
/** Compatibility name retained for teammates already importing the gateway catalog. */
export const toolDescriptorCatalog = toolRegistry;
export const toolExecutors = new InMemoryToolExecutorRegistry();
export const toolApprovalGate = new RunToolApprovalGate(store, bus, sessionStateService);
export const toolBroker = new ToolBroker(
  toolRegistry,
  toolExecutors,
  decisionService,
  sessionStateService,
  bus,
  { approvalGate: toolApprovalGate },
);
registerCoreLocalTools(toolRegistry, toolExecutors, sessionStateService);
export const browserTools = registerBrowserTools(toolRegistry, toolExecutors, {
  provider: (capability) => providers.provider(capability),
});
export const composioToolCatalog = new ComposioToolCatalog(
  providers.provider('toolbox'),
  config.providers.composio,
  toolRegistry,
  toolExecutors,
);
export const mcpConnections = new McpConnectionManager(
  store,
  toolRegistry,
  toolExecutors,
  recordEgress,
  [config.mcpGateway.url],
);
const boundTextModel = providers.provider('text.model');
export const modelGateway = new ModelGatewayService(
  decisionService,
  sessionStateService,
  boundTextModel,
  toolRegistry,
  bus,
  {
    modelRoutes: (adapter) => [
      ...modelRoutesFor(adapter),
      ...openRouterModelRoutes(config.providers.openrouter),
      ...ollamaModelRoutes(config.providers.ollama),
    ],
    backend: createOllamaBackend(
      config.providers.ollama,
      recordEgress,
      createOpenRouterBackend(
        config.providers.openrouter,
        recordEgress,
        textAdapterBackend(boundTextModel),
      ),
    ),
  },
);

export const orchestrator = new Orchestrator({
  store,
  bus,
  provider: (capability) => providers.provider(capability),
  providerFor: (capability) => providers.bindings()[capability],
  decisionService,
  sessionStateService,
  toolRegistry,
  // Graph tool nodes execute through the SAME broker a harness turn does.
  toolBroker,
  toolDiscovery: composioToolCatalog,
  localToolCandidates: async () => {
    const [mcpToolIds, registered] = await Promise.all([
      mcpConnections.candidateToolIds(),
      toolRegistry.list(),
    ]);
    const browserToolIds = registered
      .filter(
        (tool) =>
          tool.descriptor.availability === 'available' &&
          (tool.descriptor.providerId === 'localbrowser' ||
            tool.descriptor.providerId === 'browserbase'),
      )
      .map((tool) => tool.descriptor.id);
    return [...new Set([...mcpToolIds, ...browserToolIds])];
  },
  releaseRunResources: ({ runId, stepId }) =>
    browserTools.closeRunSessions(runId, {
      runId,
      stepId,
      policyRule: 'agent-task-resource-release',
    }),
});

let providersInitialized = false;

/** Discover provider schemas once, then register only tools in AgentOS's reviewed table. */
export async function initializeRuntimeProviders(): Promise<void> {
  if (providersInitialized) return;
  providersInitialized = true;
  await mcpConnections.initialize();
  await refreshComposioTools();
}

/**
 * A persisted run cannot resume its in-memory Hermes task or approval promise
 * after this process exits. Close that stale state explicitly on startup so the
 * API never presents a run as active when no worker exists to advance it.
 */
export async function recoverInterruptedRuns(): Promise<number> {
  const interrupted = (await store.listRuns({ limit: 100_000 })).filter(
    (run) => !isTerminal(run.status),
  );

  for (const run of interrupted) {
    const at = nowIso();
    for (const step of await store.listSteps(run.id)) {
      if (!['pending', 'running', 'blocked'].includes(step.status)) continue;
      const next = await store.patchStep(step.id, {
        status: step.status === 'pending' ? 'skipped' : 'failed',
        error:
          step.status === 'pending'
            ? undefined
            : { code: 'PROCESS_RESTART', message: 'Execution stopped when the API restarted.' },
        endedAt: at,
      });
      await bus.emit(run.id, { type: 'step.upserted', step: next });
    }

    for (const approval of await store.listApprovals(run.id)) {
      if (approval.status !== 'pending') continue;
      const next = await store.patchApproval(approval.id, {
        status: 'expired',
        decidedAt: at,
        note: 'Expired because the API restarted before a decision was received.',
      });
      await bus.emit(run.id, { type: 'approval.resolved', approval: next });
    }

    for (const session of await store.listSessionStates(run.id)) {
      if (['completed', 'failed', 'cancelled'].includes(session.status)) continue;
      const next = await store.patchSessionState(session.id, { status: 'cancelled' });
      await bus.emit(run.id, { type: 'session.updated', session: next });
    }

    const next = await store.patchRun(run.id, {
      status: 'cancelled',
      summary: 'Interrupted by an API restart; start a new run to continue.',
      error: {
        code: 'PROCESS_RESTART',
        message: 'The in-memory harness task could not be resumed after the API restarted.',
      },
    });
    await bus.emit(run.id, { type: 'run.updated', run: next });
  }

  if (interrupted.length > 0) {
    console.warn('[store] reconciled ' + interrupted.length.toString() + ' interrupted run(s)');
  }
  return interrupted.length;
}

/** Re-read connection state after the user completes Composio OAuth. */
export async function refreshComposioTools(): Promise<
  Awaited<ReturnType<ComposioToolCatalog['bootstrapReviewed']>>
> {
  const report = await composioToolCatalog.bootstrapReviewed();
  if (report.registered.length > 0) {
    console.log('[composio] registered: ' + report.registered.join(', '));
  }
  if (report.skipped.length > 0) {
    console.warn('[composio] skipped unreviewed/unavailable tools: ' + report.skipped.join(', '));
  }
  if (report.warning) console.warn('[composio] startup warning: ' + report.warning);
  return report;
}

export { store };
