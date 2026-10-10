import { z } from 'zod';

export const agentExecutionProfileSchema = z.enum(['adaptive', 'hermes_flagship']);

export const agentInputSchema = z.object({
  goal: z.string().trim().min(1).max(12_000),
  /** Selects the adaptive AgentOS control plane or the fixed-model Hermes baseline. */
  executionProfile: agentExecutionProfileSchema.default('adaptive'),
  context: z.unknown().optional(),
  /** Optional user/UI-provided redacted version used for cloud routing decisions. */
  sanitizedGoal: z.string().trim().min(1).max(12_000).optional(),
  dataLabels: z
    .array(z.enum(['public', 'private', 'secret', 'local_only']))
    .min(1)
    .optional(),
  maxTurns: z.number().int().min(1).max(5).default(3),
});

export type AgentInput = z.infer<typeof agentInputSchema>;
