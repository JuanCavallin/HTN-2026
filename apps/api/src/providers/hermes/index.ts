import type { AgentRuntimeAdapter, Capability } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveHermes } from './live.js';

const CAPABILITIES: readonly Capability[] = ['agent.runtime'];

export function create(cfg: ProviderConfig): AgentRuntimeAdapter {
  if (cfg.mode === 'live') return createLiveHermes(cfg);
  return createMock(cfg);
}

interface MockTask {
  polls: number;
  tools: string[];
}

function createMock(cfg: ProviderConfig): AgentRuntimeAdapter {
  const base = mockBase('hermes', CAPABILITIES, cfg.mode);
  /** Fake task state so pollTask returns 'running' once before 'done'. */
  const tasks = new Map<string, MockTask>();

  return {
    ...base,
    async startTask(input, ctx) {
      return mockCall(
        'hermes',
        'startTask',
        cfg.mode,
        ctx,
        () => {
          const taskId = 'hermes_task_' + Math.random().toString(36).slice(2, 10);
          tasks.set(taskId, { polls: 0, tools: input.tools ?? [] });
          return { taskId };
        },
        // Rough estimate proportional to the goal — enough for the ledger's
        // token/cost columns to show something non-zero before a real
        // integration reports real numbers.
        { tokensIn: Math.ceil(input.goal.length / 3), tokensOut: 0 },
      );
    },
    async pollTask(taskId, ctx) {
      return mockCall(
        'hermes',
        'pollTask',
        cfg.mode,
        ctx,
        () => {
          const task = tasks.get(taskId);
          const n = (task?.polls ?? 0) + 1;
          if (task) task.polls = n;

          if (n < 2) return { status: 'running' as const, log: ['working...'] };

          // Fabricate an audit trail using whatever tools this task was
          // actually given — this is standing in for Hermes self-reporting
          // what it invoked internally. A real integration needs to confirm
          // their API returns something equivalent; if it doesn't, this is a
          // real blind spot in the egress ledger, not a cosmetic gap.
          const used = (task?.tools ?? []).slice(0, Math.min(2, task?.tools.length ?? 0));
          const toolCalls = used.map((tool) => ({ tool, at: new Date().toISOString() }));

          return {
            status: 'done' as const,
            result: { note: 'mock agent runtime completed task ' + taskId },
            log: ['working...', 'done'],
            toolCalls,
          };
        },
        { tokensIn: 0, tokensOut: 180 },
      );
    },
    async continueTask(taskId, _input, ctx) {
      return mockCall('hermes', 'continueTask', cfg.mode, ctx, () => {
        const task = tasks.get(taskId);
        if (task) task.polls = 0;
        return null;
      });
    },
    async cancelTask(taskId, ctx) {
      return mockCall('hermes', 'cancelTask', cfg.mode, ctx, () => {
        tasks.delete(taskId);
        return null;
      });
    },
  };
}
