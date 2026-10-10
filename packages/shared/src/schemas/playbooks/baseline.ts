/**
 * Input schema for the built-in `baseline` playbook.
 *
 * The naive comparison point: one frontier-tier LLM call, no tools, no graph,
 * no redaction gate. Same `target` vocabulary as `demo`'s input, so the same
 * case file can be handed to both for an apples-to-apples run.
 */

import { z } from 'zod';

export const baselineInputSchema = z.object({
  target: z.string().min(1).max(200).default('ACME-2026-TERM-FEES'),
  /**
   * Links this attempt to the same task lineage as a graph run, so the
   * comparison view can find "the graph run this baseline is measured
   * against" and the run-history query on that graph picks up both.
   */
  graphId: z.string().min(1).optional(),
});

export type BaselineInput = z.infer<typeof baselineInputSchema>;
