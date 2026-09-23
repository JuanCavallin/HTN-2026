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
  graphId: z.string().min(1).optional(),
  status: z
    .enum(['pending', 'running', 'awaiting_approval', 'paused', 'succeeded', 'failed', 'cancelled'])
    .optional(),
  kind: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

/**
 * The three human answers to a gated action. 'revised' is not a flavour of
 * 'approved': it replaces the payload, and the replacement goes back through
 * the risk gate before anything runs.
 */
export const approvalDecisionSchema = z
  .object({
    decision: z.enum(['approved', 'rejected', 'revised']),
    note: z.string().max(1000).optional(),
    /**
     * The edited payload. Only the payload is editable — the action's kind
     * and destination are what the risk classification was built on, so
     * letting the client restate them would let a revision walk around the
     * gate rather than through it.
     */
    revisedPayload: z.unknown().optional(),
    /** Optional edit to the monetary impact, which the gate re-reads. */
    revisedAmountCents: z.number().int().min(0).optional(),
  })
  .refine((v) => v.decision !== 'revised' || v.revisedPayload !== undefined, {
    message: 'revisedPayload is required when decision is "revised"',
    path: ['revisedPayload'],
  });
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const runIdParamSchema = z.object({ id: z.string().min(1) });
export const egressQuerySchema = z.object({ runId: z.string().min(1) });

/** Uniform error body from the API. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
