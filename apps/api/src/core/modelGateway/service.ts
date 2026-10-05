import type {
  AgentSessionState,
  ControlDecisionOperation,
  DataLabel,
  DecisionState,
  ModelRoute,
  ModelTier,
  ProviderCallContext,
  TextModelAdapter,
  ToolDescriptor,
} from '@htn/shared';
import { newId, nowIso } from '../../lib/ids.js';
import type { RunBus } from '../bus.js';
import type { DecisionService } from '../decisions/service.js';
import { decisionStateFromSession } from '../sessions/decisionState.js';
import type { GatewayTurnBinding, SessionStateService } from '../sessions/service.js';
import { KeyedLock } from '../locks.js';
import type { RegisteredTool } from '../tools/registry.js';
import { modelRoutesFor } from './catalog.js';
import type { ToolDescriptorCatalog } from './toolCatalog.js';

export interface OpenAiMessage {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface OpenAiTool {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}

export interface OpenAiChatRequest {
  model?: string;
  messages?: OpenAiMessage[];
  tools?: OpenAiTool[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  [key: string]: unknown;
}

export interface GatewayCompletion {
  id: string;
  created: number;
  model: string;
  text: string;
  toolCalls: GatewayToolCall[];
  tokensIn: number;
  tokensOut: number;
  runId: string;
  sessionStateId: string;
  selectedToolIds: string[];
}

export interface GatewayToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatModelBackendInput {
  route: ModelRoute;
  messages: OpenAiMessage[];
  tools: OpenAiTool[];
  maxTokens?: number;
}

export interface ChatModelBackendResult {
  text: string;
  toolCalls?: GatewayToolCall[];
  tokensIn: number;
  tokensOut: number;
  actualModel?: string;
  estimatedCostCents?: number;
}

/** Provider-specific tool-capable backends implement this seam. */
export interface ChatModelBackend {
  complete(input: ChatModelBackendInput, ctx: ProviderCallContext): Promise<ChatModelBackendResult>;
}

export interface ModelGatewayOptions {
  modelRoutes?: (adapter: TextModelAdapter) => ModelRoute[];
  backend?: ChatModelBackend;
}

export class ModelGatewayService {
  private readonly calls = new KeyedLock();
  private readonly routes: ModelRoute[];
  private readonly backend: ChatModelBackend;

  constructor(
    private readonly decisionService: DecisionService,
    private readonly sessions: SessionStateService,
    private readonly model: TextModelAdapter,
    private readonly tools: ToolDescriptorCatalog,
    private readonly bus: RunBus,
    options: ModelGatewayOptions = {},
  ) {
    this.routes = (options.modelRoutes ?? modelRoutesFor)(model);
    this.backend = options.backend ?? textAdapterBackend(model);
  }

  listModels(): ModelRoute[] {
    return this.routes.filter((route) => route.enabled);
  }

  async complete(
    request: OpenAiChatRequest,
    binding: GatewayTurnBinding,
  ): Promise<GatewayCompletion> {
    const release = await this.calls.acquire(binding.sessionStateId);
    try {
      return await this.completeBound(request, binding);
    } finally {
      release();
    }
  }

  private async completeBound(
    request: OpenAiChatRequest,
    binding: GatewayTurnBinding,
  ): Promise<GatewayCompletion> {
    const initialSession = await this.sessions.requireGatewayTurn(binding);
    const messages = Array.isArray(request.messages) ? request.messages : [];
    if (messages.length === 0) throw new Error('messages must contain at least one item');

    await this.sessions.appendContext(
      initialSession.id,
      messages.map((message) => summarizeMessage(message, initialSession)),
    );
    const session = await this.sessions.get(initialSession.id);
    if (!session) throw new Error('Active AgentOS session disappeared during model routing.');

    const decisionState = decisionStateFromSession(session);
    const callContext: ProviderCallContext = {
      runId: session.runId,
      stepId: session.stepId,
      policyRule: 'agentos-model-gateway',
    };

    const requestedToolNames = extractToolNames(request.tools ?? []);
    const taskGrant = session.taskToolIds ?? session.candidateToolIds;
    const requestTools = await this.resolveRequestedTools(
      request.tools ?? [],
      taskGrant.filter(
        (id) => session.toolCeiling === undefined || session.toolCeiling.includes(id),
      ),
    );
    const trustedDescriptors = requestTools
      .map((tool) => tool.registered.descriptor)
      .filter((descriptor) =>
        session.boundBrowserSessionId ? !isSeparateBrowserOperation(descriptor.id) : true,
      );
    if (
      session.candidateToolIds.length > 0 &&
      requestedToolNames.length > 0 &&
      trustedDescriptors.length === 0
    ) {
      // Names and stable IDs are safe operational metadata; never log schemas
      // or arguments here because those can contain user/private task data.
      console.warn(
        '[model-gateway] no trusted schema resolved; candidates=' +
          JSON.stringify(session.candidateToolIds) +
          ' requestNames=' +
          JSON.stringify(requestedToolNames),
      );
    }
    // The task-level Jev grant is already the hard capability decision passed
    // into Hermes. Re-running family/tool Jev on every gateway turn adds
    // latency and can only narrow a set that is already bounded. Preserve the
    // legacy per-turn selector for sessions created before taskToolIds existed.
    const selectedTools =
      session.taskToolIds !== undefined
        ? trustedDescriptors
        : await this.selectTools(
            decisionState,
            trustedDescriptors,
            callContext,
            session.runId,
            session.stepId,
          );
    const selectedIds = new Set(selectedTools.map((descriptor) => descriptor.id));
    const selectedRequestTools = requestTools.filter((tool) =>
      selectedIds.has(tool.registered.descriptor.id),
    );
    const modelCandidates =
      selectedTools.length > 0 ? this.routes.filter((route) => route.supportsTools) : this.routes;
    const modelDecision = await this.decisionService.selectModel(
      decisionState,
      modelCandidates,
      callContext,
    );
    const selectedRoute = modelCandidates.find(
      (route) => route.id === modelDecision.selectedRouteId,
    );
    if (!selectedRoute) throw new Error('Selected model route is no longer available.');
    await this.emitDecision(
      session.runId,
      session.stepId,
      'select_model',
      modelCandidates.map((route) => route.id),
      [selectedRoute.id],
      modelDecision.confidence,
      modelDecision.reasonCodes,
    );

    const selectedToolSchemas = await Promise.all(
      selectedRequestTools.map(async ({ requestName, registered }): Promise<OpenAiTool> => {
        const descriptor = registered.descriptor;
        const current = await this.tools.get(descriptor.id);
        if (!current || current.descriptor.version !== descriptor.version) {
          throw new Error('Selected tool changed before its trusted schema was exposed.');
        }
        return {
          type: 'function',
          function: {
            name: requestName,
            description: descriptor.description,
            parameters: current.inputSchema,
          },
        };
      }),
    );

    const modelCallId = newId('chatcmpl');
    await this.sessions.requireGatewayTurn(binding);
    // Hermes can send built-in/core schemas that are not AgentOS capabilities.
    // Those must not erase the outer Jev selection. The task grant remains
    // immutable; only the selected descriptor versions are updated here.
    const trustedToolBearingRequest = trustedDescriptors.length > 0;
    await this.sessions.recordRouting(session.id, {
      candidateModelRouteIds: modelCandidates.map((route) => route.id),
      selectedModelRouteId: selectedRoute.id,
      ...(trustedToolBearingRequest
        ? {
            selectedToolIds: selectedTools.map((descriptor) => descriptor.id),
            selectedToolVersions: Object.fromEntries(
              selectedTools.map((descriptor) => [descriptor.id, descriptor.version]),
            ),
          }
        : {}),
    });
    if (trustedToolBearingRequest) {
      await this.sessions.grantToolExposure(session.id, {
        modelCallId,
        selectedToolVersions: Object.fromEntries(
          selectedTools.map((descriptor) => [descriptor.id, descriptor.version]),
        ),
      });
    }

    const modelStartedAt = Date.now();
    await this.emitModelLifecycle({
      modelCallId,
      runId: session.runId,
      stepId: session.stepId,
      sessionStateId: session.id,
      phase: 'requested',
      routeId: selectedRoute.id,
      providerId: selectedRoute.providerId,
      configuredModelId: selectedRoute.modelId,
      selectedToolIds: selectedTools.map((descriptor) => descriptor.id),
      dataLabels: session.dataLabels,
      messageCount: messages.length,
    });

    let completed: ChatModelBackendResult;
    try {
      await this.sessions.requireGatewayTurn(binding);
      completed = await this.backend.complete(
        {
          route: selectedRoute,
          messages,
          tools: selectedToolSchemas,
          maxTokens: request.max_completion_tokens ?? request.max_tokens,
        },
        callContext,
      );
    } catch (error) {
      if (trustedToolBearingRequest) await this.sessions.clearToolExposure(session.id);
      await this.emitModelLifecycle({
        modelCallId,
        runId: session.runId,
        stepId: session.stepId,
        sessionStateId: session.id,
        phase: 'failed',
        routeId: selectedRoute.id,
        providerId: selectedRoute.providerId,
        configuredModelId: selectedRoute.modelId,
        selectedToolIds: selectedTools.map((descriptor) => descriptor.id),
        dataLabels: session.dataLabels,
        messageCount: messages.length,
        latencyMs: Date.now() - modelStartedAt,
        error: {
          code: 'MODEL_CALL_FAILED',
          message: error instanceof Error ? compactSummary(error.message) : 'Model call failed.',
        },
      });
      throw error;
    }

    await this.sessions.requireGatewayTurn(binding);
    await this.emitModelLifecycle({
      modelCallId,
      runId: session.runId,
      stepId: session.stepId,
      sessionStateId: session.id,
      phase: 'completed',
      routeId: selectedRoute.id,
      providerId: selectedRoute.providerId,
      configuredModelId: selectedRoute.modelId,
      actualModelId: completed.actualModel ?? selectedRoute.modelId,
      selectedToolIds: selectedTools.map((descriptor) => descriptor.id),
      dataLabels: session.dataLabels,
      messageCount: messages.length,
      latencyMs: Date.now() - modelStartedAt,
      tokensIn: completed.tokensIn,
      tokensOut: completed.tokensOut,
      estimatedCostCents: completed.estimatedCostCents,
      toolCallCount: completed.toolCalls?.length ?? 0,
    });

    const latest = await this.sessions.get(session.id);
    await this.sessions.appendContext(session.id, [
      {
        role: 'assistant',
        summary: compactSummary(completed.text || '(model proposed tool calls)'),
        // A model answer may incorporate a harness system prompt, so it is not
        // automatically promoted into remote-safe Jev context.
        sanitizedSummary: undefined,
        dataLabels: session.dataLabels,
        tokenEstimate: completed.tokensOut,
      },
    ]);

    return {
      id: modelCallId,
      created: Math.floor(Date.now() / 1000),
      model: completed.actualModel ?? selectedRoute.modelId,
      text: completed.text,
      toolCalls: completed.toolCalls ?? [],
      tokensIn: completed.tokensIn,
      tokensOut: completed.tokensOut,
      runId: session.runId,
      sessionStateId: latest?.id ?? session.id,
      selectedToolIds: selectedTools.map((descriptor) => descriptor.id),
    };
  }

  private async resolveRequestedTools(
    tools: OpenAiTool[],
    allowedToolIds: string[],
  ): Promise<{ requestName: string; registered: RegisteredTool }[]> {
    const allowed = new Set(allowedToolIds);
    const resolved: { requestName: string; registered: RegisteredTool }[] = [];
    const seenToolIds = new Set<string>();
    for (const requestName of extractToolNames(tools)) {
      const rawWireName = requestName.startsWith('mcp__agentos__')
        ? requestName.slice('mcp__agentos__'.length)
        : requestName;
      const registered =
        (await this.tools.get(requestName)) ?? (await this.tools.getByWireName(rawWireName));
      if (
        !registered ||
        !allowed.has(registered.descriptor.id) ||
        seenToolIds.has(registered.descriptor.id)
      ) {
        continue;
      }
      seenToolIds.add(registered.descriptor.id);
      resolved.push({ requestName, registered });
    }
    return resolved;
  }

  private async selectTools(
    state: DecisionState,
    candidates: ToolDescriptor[],
    ctx: ProviderCallContext,
    runId: string,
    stepId: string,
  ): Promise<ToolDescriptor[]> {
    const families = [...new Set(candidates.map((candidate) => candidate.family))];
    const familyDecision = await this.decisionService.selectToolFamilies(state, families, ctx);
    await this.emitDecision(
      runId,
      stepId,
      'select_tool_families',
      families,
      familyDecision.selectedFamilies,
      average(Object.values(familyDecision.confidences)),
      familyDecision.reasonCodes,
    );
    const familySet = new Set(familyDecision.selectedFamilies);
    const narrowed = candidates.filter((candidate) => familySet.has(candidate.family));
    const toolDecision = await this.decisionService.selectTools(state, narrowed, ctx);
    await this.emitDecision(
      runId,
      stepId,
      'select_tools',
      narrowed.map((candidate) => candidate.id),
      toolDecision.selectedToolIds,
      average(Object.values(toolDecision.confidences)),
      toolDecision.reasonCodes,
    );
    const selected = new Set(toolDecision.selectedToolIds);
    return narrowed.filter((candidate) => selected.has(candidate.id));
  }

  private async emitDecision(
    runId: string,
    stepId: string,
    operation: ControlDecisionOperation,
    candidateIds: string[],
    selectedIds: string[],
    confidence: number,
    reasonCodes: string[],
  ): Promise<void> {
    const fallback = reasonCodes.some(
      (reason) => reason.includes('fallback') || reason.includes('deterministic'),
    );
    await this.bus.emit(runId, {
      type: 'control.decided',
      decision: {
        id: newId('ctl'),
        runId,
        stepId,
        operation,
        candidateIds,
        selectedIds,
        confidence,
        reasonCodes,
        source: fallback ? 'fallback' : 'jev',
        at: nowIso(),
      },
    });
  }

  private async emitModelLifecycle(input: {
    modelCallId: string;
    runId: string;
    stepId?: string;
    sessionStateId: string;
    phase: 'requested' | 'completed' | 'failed';
    routeId: string;
    providerId: string;
    configuredModelId: string;
    actualModelId?: string;
    selectedToolIds: string[];
    dataLabels: DataLabel[];
    messageCount: number;
    latencyMs?: number;
    tokensIn?: number;
    tokensOut?: number;
    estimatedCostCents?: number;
    toolCallCount?: number;
    error?: { code: string; message: string };
  }): Promise<void> {
    await this.bus.emit(input.runId, {
      type: 'model.lifecycle',
      lifecycle: {
        id: newId('model_evt'),
        ...input,
        dataLabels: [...input.dataLabels],
        selectedToolIds: [...input.selectedToolIds],
        at: nowIso(),
      },
    });
  }
}

function isSeparateBrowserOperation(toolId: string): boolean {
  return (
    (toolId.startsWith('browserbase.') || toolId.startsWith('localbrowser.')) &&
    ['open', 'search', 'read'].includes(toolId.slice(toolId.lastIndexOf('.') + 1))
  );
}

function summarizeMessage(
  message: OpenAiMessage,
  session: AgentSessionState,
): {
  role: 'system' | 'user' | 'assistant' | 'tool';
  summary: string;
  sanitizedSummary?: string;
  dataLabels: DataLabel[];
  tokenEstimate: number;
} {
  const role =
    message.role === 'system' || message.role === 'assistant' || message.role === 'tool'
      ? message.role
      : 'user';
  const text =
    role === 'tool'
      ? unwrapHermesToolEnvelope(contentText(message.content))
      : contentText(message.content);
  const summary = compactSummary(text);
  const trustedToolEntry =
    role === 'tool'
      ? [...session.context]
          .reverse()
          .find(
            (entry) =>
              entry.role === 'tool' &&
              Boolean(entry.sanitizedSummary) &&
              entry.sanitizedSummary === summary,
          )
      : undefined;
  const dataLabels = trustedToolEntry
    ? trustedToolEntry.dataLabels
    : role === 'tool'
      ? [...new Set<DataLabel>([...session.dataLabels, 'local_only'])]
      : session.dataLabels;
  const maySanitize =
    (role === 'user' && labelsArePublic(dataLabels)) ||
    (role === 'tool' && Boolean(trustedToolEntry) && labelsArePublic(dataLabels));
  return {
    role,
    summary,
    sanitizedSummary: maySanitize ? summary : undefined,
    dataLabels,
    tokenEstimate: Math.ceil(text.length / 4),
  };
}

/**
 * Hermes wraps external tool results in a fixed prompt-injection envelope
 * (hermes-agent/agent/tool_dispatch_helpers.py `_maybe_wrap_untrusted`) before
 * echoing them back. Unwrapped, the body is byte-identical to the MCP result,
 * so it can match the broker's trusted entry. Without this every browser
 * result was labelled local_only, which then spread to the whole session and
 * blocked every cloud route ("No policy-eligible model route is available").
 *
 * Unwrapping grants nothing on its own: the body must still equal a summary
 * AgentOS recorded as public, or it gets local_only as before.
 */
const HERMES_TOOL_ENVELOPE = /^<untrusted_tool_result source="[^"\n]*">\n[^\n]*\n\n([\s\S]*)\n<\/untrusted_tool_result>$/;

function unwrapHermesToolEnvelope(text: string): string {
  const body = HERMES_TOOL_ENVELOPE.exec(text)?.[1] ?? text;
  // Hermes re-encodes an MCP call's text as exactly {"result": "<text>"} on
  // success or {"error": "<text>"} on failure. The inner text is what AgentOS
  // recorded (broker for results, core/mcp/server.ts for errors).
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      const value = (parsed as Record<string, unknown>)[keys[0] ?? ''];
      if (keys.length === 1 && (keys[0] === 'result' || keys[0] === 'error')) {
        if (typeof value === 'string') return value;
      }
    }
  } catch {
    // Not JSON: an ordinary tool result.
  }
  return body;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return typeof part.text === 'string' ? part.text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

export function compactSummary(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty message)';
  return normalized.length <= 320 ? normalized : normalized.slice(0, 317) + '...';
}

function extractToolNames(tools: OpenAiTool[]): string[] {
  return [
    ...new Set(
      tools.flatMap((tool) =>
        typeof tool.function?.name === 'string' && tool.function.name ? [tool.function.name] : [],
      ),
    ),
  ];
}

function labelsArePublic(labels: DataLabel[]): boolean {
  return labels.every((label) => label === 'public');
}

function average(values: number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function routeToTier(route: ModelRoute): ModelTier {
  return route.deployment === 'local' ? 'local' : route.costTier;
}

export function textAdapterBackend(model: TextModelAdapter): ChatModelBackend {
  return {
    async complete(input, ctx) {
      const prompt = input.messages
        .filter((message) => message.role !== 'system')
        .map((message) => message.role + ': ' + contentText(message.content))
        .join('\n');
      const system = input.messages
        .filter((message) => message.role === 'system')
        .map((message) => contentText(message.content))
        .join('\n');
      const completed = await model.complete(
        {
          system: system || undefined,
          prompt,
          maxTokens: input.maxTokens,
          tier: routeToTier(input.route),
        },
        ctx,
      );
      if (!completed.ok) throw new Error('Selected model failed: ' + completed.error.message);
      return completed.data;
    },
  };
}
