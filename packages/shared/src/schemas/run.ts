/**
 * Request/response schemas. Defined ONCE here so the API validates and the web
 * app type-checks against the same definition — no hand-redeclared shapes, no drift.
 */

import { z } from 'zod';

export const createRunRequestSchema = z.object({
  /** Must match a registered playbook kind. */
  kind: z.string().min(1),
  /** Validated a second time against the playbook's own input schema. */
  input: z.unknown().default({}),
  title: z.string().min(1).max(200).optional(),
});
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

export const listRunsQuerySchema = z.object({
  status: z
    .enum(['pending', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled'])
    .optional(),
  kind: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

export const approvalDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(1000).optional(),
});
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const runIdParamSchema = z.object({ id: z.string().min(1) });
export const egressQuerySchema = z.object({ runId: z.string().min(1) });

/** Uniform error body from the API. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
