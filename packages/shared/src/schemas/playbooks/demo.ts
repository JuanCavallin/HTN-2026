/**
 * Input schema for the built-in `demo` playbook.
 *
 * This file is the TEMPLATE for the pivot: when the product idea is chosen, copy
 * this file, rename it, and write the matching playbook in
 * apps/api/src/core/playbooks/. Nothing else in the codebase needs to change.
 */

import { z } from 'zod';

export const demoInputSchema = z.object({
  /** Free-text subject the fake agent pretends to investigate. */
  target: z.string().min(1).max(200).default('ACME-2026-TERM-FEES'),
  /** How many parallel workers to fan out. Drives the SwarmGrid. */
  workerCount: z.number().int().min(1).max(8).default(3),
  /** Include a sensitive-looking value so the redaction path is exercised. */
  includeSensitive: z.boolean().default(true),
});

export type DemoInput = z.infer<typeof demoInputSchema>;
