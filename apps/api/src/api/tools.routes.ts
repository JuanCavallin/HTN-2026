/**
 * The tool catalog, for the graph editor's per-node tool picker.
 *
 * Served through services/toolCatalog.ts: the `toolbox` CAPABILITY (not a
 * vendor) merged with the tool plane's registry, so this endpoint grows on its
 * own when a provider or a plugin manifest is added. See providers/registry.ts
 * BINDINGS.
 */

import { Router } from 'express';
import type { ToolCatalogEntry } from '@htn/shared';
import { listToolCatalog } from '../services/toolCatalog.js';
import { HttpError } from './middleware/validate.js';

export const toolsRouter: Router = Router();

/**
 * The catalog is read through withEgress, which records a ledger row per call.
 * A tool picker filtering on every keystroke would otherwise write one row (and
 * one bus event) per keystroke, so hold the result briefly. Short enough that a
 * newly connected Composio account still shows up within a minute.
 */
const TTL_MS = 60_000;

let cache: { at: number; tools: ToolCatalogEntry[] } | null = null;

toolsRouter.get('/tools', async (_req, res) => {
  if (cache && Date.now() - cache.at < TTL_MS) {
    res.json({ tools: cache.tools, cached: true });
    return;
  }

  // No run owns this call, but every outbound call is logged — there is no
  // anonymous egress. A synthetic runId keeps that invariant true; the `sys_`
  // prefix cannot collide with a real `run_` id.
  const result = await listToolCatalog({
    runId: 'sys_catalog',
    policyRule: 'tool-catalog-read',
  });

  if (!result.ok) {
    throw new HttpError(
      502,
      result.error.code,
      'Tool catalog unavailable: ' + result.error.message,
    );
  }

  cache = { at: Date.now(), tools: result.data };
  res.json({ tools: result.data, cached: false });
});
