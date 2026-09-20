import type {
  AgentSessionState,
  AgentSessionStatus,
  DataLabel,
  SessionBudget,
  SessionCheckpoint,
  SessionContextEntry,
  ToolExposureGrant,
} from '@htn/shared';
import { newId, nowIso } from '../../lib/ids.js';
import type { Store } from '../../store/types.js';
import type { RunBus } from '../bus.js';

const MAX_CONTEXT_ENTRIES = 80;
const ACTIVE_STATUSES = new Set<AgentSessionStatus>(['created', 'running']);

export interface CreateSessionStateInput {
  runId: string;
  stepId: string;
  harness: string;
  objective: string;
  sanitizedObjective?: string;
  dataLabels: DataLabel[];
  budget: SessionBudget;
  candidateModelRouteIds?: string[];
  candidateToolIds?: string[];
}

/**
 * Owns the canonical, harness-independent state used by routing, completion,
 * and the future UI. It intentionally stores summaries rather than raw model
 * messages or tool payloads.
 */
export class SessionStateService {
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly bus?: RunBus,
  ) {}

  async create(input: CreateSessionStateInput): Promise<AgentSessionState> {
    const at = nowIso();
    const state = await this.store.createSessionState({
      id: newId('ses'),
      runId: input.runId,
      stepId: input.stepId,
      harness: input.harness,
      objective: input.objective,
      sanitizedObjective: input.sanitizedObjective,
      dataLabels: [...new Set(input.dataLabels)],
      status: 'created',
      turn: 0,
      contextVersion: 0,
      context: [],
      candidateModelRouteIds: input.candidateModelRouteIds ?? [],
      candidateToolIds: input.candidateToolIds ?? [],
      selectedToolIds: [],
      budget: input.budget,
      createdAt: at,
      updatedAt: at,
    });
    await this.emit(state);
    return state;
  }

  get(id: string): Promise<AgentSessionState | null> {
    return this.store.getSessionState(id);
  }

  patch(id: string, patch: Partial<AgentSessionState>): Promise<AgentSessionState> {
    return this.savePatch(id, patch);
  }

  async bindHarnessSession(id: string, harnessSessionId: string): Promise<AgentSessionState> {
    return this.savePatch(id, { harnessSessionId });
  }

  async beginTurn(id: string): Promise<AgentSessionState> {
    const current = await this.require(id);
    return this.savePatch(id, {
      status: 'running',
      turn: current.turn + 1,
      activeToolExposureGrant: undefined,
    });
  }

  async appendContext(
    id: string,
    entries: Omit<SessionContextEntry, 'id' | 'at'>[],
  ): Promise<AgentSessionState> {
    if (entries.length === 0) return this.require(id);
    return this.serialize(id, async () => {
      const current = await this.require(id);
      const at = nowIso();
      const appended = entries.map((entry) => ({ ...entry, id: newId('ctx'), at }));
      return this.savePatch(id, {
        context: [...current.context, ...appended].slice(-MAX_CONTEXT_ENTRIES),
        contextVersion: current.contextVersion + 1,
        dataLabels: mergeLabels(
          current.dataLabels,
          appended.flatMap((entry) => entry.dataLabels),
        ),
      });
    });
  }

  async recordRouting(
    id: string,
    input: {
      candidateModelRouteIds: string[];
      selectedModelRouteId: string;
      candidateToolIds?: string[];
      selectedToolIds?: string[];
      selectedToolVersions?: Record<string, string>;
    },
  ): Promise<AgentSessionState> {
    return this.savePatch(id, input);
  }

  async grantToolExposure(
    id: string,
    input: {
      modelCallId: string;
      selectedToolVersions: Record<string, string>;
    },
  ): Promise<AgentSessionState> {
    const current = await this.require(id);
    const grant: ToolExposureGrant = {
      id: newId('grant'),
      sessionStateId: current.id,
      turn: current.turn,
      modelCallId: input.modelCallId,
      selectedToolVersions: { ...input.selectedToolVersions },
      createdAt: nowIso(),
    };
    return this.savePatch(id, { activeToolExposureGrant: grant });
  }

  clearToolExposure(id: string): Promise<AgentSessionState> {
    return this.savePatch(id, { activeToolExposureGrant: undefined });
  }

  async setStatusForStep(
    runId: string,
    stepId: string,
    status: AgentSessionStatus,
  ): Promise<AgentSessionState> {
    const matches = (await this.store.listSessionStates(runId)).filter(
      (state) => state.stepId === stepId,
    );
    if (matches.length !== 1) {
      throw new Error(
        'Expected exactly one session for run/step ' +
          runId +
          '/' +
          stepId +
          ', found ' +
          matches.length,
      );
    }
    return this.savePatch(matches[0].id, { status });
  }

  async checkpoint(
    id: string,
    checkpoint: SessionCheckpoint,
    status: AgentSessionStatus = 'quiescent',
  ): Promise<AgentSessionState> {
    return this.savePatch(id, {
      latestCheckpoint: checkpoint,
      budget: checkpoint.budget,
      status,
      activeToolExposureGrant: undefined,
    });
  }

  setStatus(id: string, status: AgentSessionStatus): Promise<AgentSessionState> {
    return this.savePatch(id, {
      status,
      ...(!ACTIVE_STATUSES.has(status) && status !== 'awaiting_approval'
        ? { activeToolExposureGrant: undefined }
        : {}),
    });
  }

  /**
   * Hermes's OpenAI-compatible request does not carry our run ID. The isolated
   * demo profile therefore resolves the only active Hermes turn. Concurrency is
   * rejected instead of ever attaching model traffic to the wrong session.
   */
  async resolveActiveHarnessSession(harness: string): Promise<AgentSessionState> {
    const active = (await this.store.listSessionStates()).filter(
      (state) => state.harness === harness && ACTIVE_STATUSES.has(state.status),
    );
    if (active.length === 0) {
      throw new Error('No active ' + harness + ' session is registered with AgentOS.');
    }
    if (active.length > 1) {
      throw new Error(
        'Multiple active ' + harness + ' sessions are ambiguous; refusing to cross-wire context.',
      );
    }
    return active[0];
  }

  private async require(id: string): Promise<AgentSessionState> {
    const state = await this.store.getSessionState(id);
    if (!state) throw new Error('Agent session state not found: ' + id);
    return state;
  }

  private async savePatch(
    id: string,
    patch: Partial<AgentSessionState>,
  ): Promise<AgentSessionState> {
    const state = await this.store.patchSessionState(id, patch);
    await this.emit(state);
    return state;
  }

  private async emit(state: AgentSessionState): Promise<void> {
    await this.bus?.emit(state.runId, { type: 'session.updated', session: state });
  }

  /** Hermes may issue the main completion and auxiliary title call together. */
  private serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
    const prior = this.mutations.get(id) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(work);
    this.mutations.set(id, current);
    return current.finally(() => {
      if (this.mutations.get(id) === current) this.mutations.delete(id);
    });
  }
}

function mergeLabels(base: DataLabel[], additions: DataLabel[]): DataLabel[] {
  return [...new Set<DataLabel>([...base, ...additions])];
}
