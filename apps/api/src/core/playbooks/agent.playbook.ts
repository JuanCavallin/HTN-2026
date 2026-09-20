import { agentInputSchema, type AgentInput, type Json } from '@htn/shared';
import { definePlaybook } from './types.js';

/** Generic UI entry point: one user objective becomes one supervised Hermes run. */
export const agentPlaybook = definePlaybook<AgentInput>({
  kind: 'agent',
  title: 'Run a supervised agent task',
  directLaunch: false,
  inputSchema: agentInputSchema,

  async execute(ctx, input) {
    const redaction = await ctx.redact(input.goal, 'agent_goal');
    const dataLabels =
      input.dataLabels ?? (redaction.hadSensitive ? (['private'] as const) : (['public'] as const));
    const sanitizedGoal =
      input.sanitizedGoal ??
      (input.dataLabels && input.dataLabels.some((label) => label !== 'public')
        ? undefined
        : redaction.redacted);
    const agentTask = await ctx.runAgentTask({
      label: 'Run supervised agent task',
      goal: input.goal,
      context: input.context,
      sanitizedGoal,
      dataLabels: [...dataLabels],
      availableTools: [],
      maxTurns: input.maxTurns,
    });
    return {
      summary: 'Agent task completed with verified Jev completion.',
      result: toJson({
        output: agentTask.result,
        exposedTools: agentTask.scheduleDecision.exposedTools,
        modelTier: agentTask.scheduleDecision.modelTier,
        completion: agentTask.completionDecision,
      }),
    };
  },
});

function toJson(value: unknown): Json {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as Json;
  } catch {
    return String(value);
  }
}
