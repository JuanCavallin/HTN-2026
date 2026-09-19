import type { AgentRuntimeAdapter, Capability } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveHermes } from './live.js';

const CAPABILITIES: readonly Capability[] = ['agent.runtime'];

export function create(cfg: ProviderConfig): AgentRuntimeAdapter {
  if (cfg.mode === 'live') return createLiveHermes(cfg);
  return createMock(cfg);
}

function createMock(cfg: ProviderConfig): AgentRuntimeAdapter {
  const base = mockBase('hermes', CAPABILITIES, cfg.mode);
  /** Fake task state so pollTask returns 'running' once before 'done'. */
  const polls = new Map<string, number>();

  return {
    ...base,
    async startTask(input, ctx) {
      return mockCall('hermes', 'startTask', cfg.mode, ctx, () => {
        const taskId = 'hermes_task_' + Math.random().toString(36).slice(2, 10);
        polls.set(taskId, 0);
        void input;
        return { taskId };
      });
    },
    async pollTask(taskId, ctx) {
      return mockCall('hermes', 'pollTask', cfg.mode, ctx, () => {
        const n = (polls.get(taskId) ?? 0) + 1;
        polls.set(taskId, n);
        if (n < 2) return { status: 'running' as const, log: ['working...'] };
        return {
          status: 'done' as const,
          result: { note: 'mock agent runtime completed task ' + taskId },
          log: ['working...', 'done'],
        };
      });
    },
    async cancelTask(taskId, ctx) {
      return mockCall('hermes', 'cancelTask', cfg.mode, ctx, () => {
        polls.delete(taskId);
        return null;
      });
    },
  };
}
