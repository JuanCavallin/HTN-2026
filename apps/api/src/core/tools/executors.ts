import type { DataLabel, Json, ProviderCallContext, ToolAction, ToolDescriptor } from '@htn/shared';

export interface ToolExecutionOutput {
  output: Json;
  /** Compact text only. Raw tool output never enters canonical session state or SSE. */
  summary: string;
  /** Sensitivity of the executor output; these labels can only tighten session policy. */
  dataLabels: DataLabel[];
  /** Deliberately prepared text that may be returned to a remote model when labels allow it. */
  sanitizedSummary?: string;
  /** Required when AgentOS policy says the result needs verification. */
  verified?: boolean;
}

export interface ToolExecutor {
  readonly ref: string;
  /** Pure/local resolution performed before authorization. No network calls here. */
  destinationFor(input: { descriptor: ToolDescriptor; arguments: Json }): string | undefined;
  execute(action: ToolAction, ctx: ProviderCallContext): Promise<ToolExecutionOutput>;
}

export interface ToolExecutorRegistry {
  resolve(executorRef: string): ToolExecutor | null;
}

export class InMemoryToolExecutorRegistry implements ToolExecutorRegistry {
  private readonly executors = new Map<string, ToolExecutor>();

  register(executor: ToolExecutor): void {
    if (!executor.ref.trim()) throw new Error('Tool executor ref is required.');
    if (this.executors.has(executor.ref)) {
      throw new Error('Tool executor already registered: ' + executor.ref);
    }
    this.executors.set(executor.ref, executor);
  }

  unregister(executorRef: string): boolean {
    return this.executors.delete(executorRef);
  }

  resolve(executorRef: string): ToolExecutor | null {
    return this.executors.get(executorRef) ?? null;
  }
}
