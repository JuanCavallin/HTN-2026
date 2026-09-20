/**
 * The tool catalog backing the node inspector's tool pickers.
 *
 * Same shape as useGraphs: fetch once, expose a refresh. The server already
 * caches this behind a short TTL (see tools.routes.ts), so there is no need
 * to duplicate that here.
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export interface ToolCatalogEntry {
  name: string;
  description: string;
}

export function useTools() {
  const [tools, setTools] = useState<ToolCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .tools()
      .then(({ tools: list }) => {
        if (!cancelled) setTools(list);
      })
      .catch(() => {
        // The inspector degrades to free-text tool fields when the catalog
        // can't be loaded -- not fatal, so no error state to thread through.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { tools, loading };
}
