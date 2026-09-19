/**
 * Graph fetching, following the same shape as useRuns.
 *
 * Deliberately no SSE here: a graph is a document, not a stream. It changes
 * when someone saves it, and the saver already has the new copy in the response
 * -- so `refresh` exists for the cases where someone else changed it.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AgentGraph } from '@htn/shared';
import { api } from '../lib/api';

export function useGraphs() {
  const [graphs, setGraphs] = useState<AgentGraph[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { graphs: list } = await api.graphs();
      setGraphs(list);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { graphs, loading, error, refresh };
}

export function useGraph(id: string | undefined) {
  const [graph, setGraph] = useState<AgentGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const { graph: found } = await api.graph(id);
      setGraph(found);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { graph, error, refresh, setGraph };
}

/**
 * The graph a run executed. Prefers the SNAPSHOT stored on the run, so an old
 * run page keeps showing the document its steps line up with even after the
 * graph has been edited. Falls back to a live load for runs created before
 * snapshots existed.
 */
export function useRunGraph(runInput: unknown): AgentGraph | null {
  const snapshot = (runInput as { graphSnapshot?: AgentGraph } | null)?.graphSnapshot ?? null;
  const graphId = (runInput as { graphId?: string } | null)?.graphId;

  const { graph } = useGraph(snapshot ? undefined : graphId);
  return snapshot ?? graph;
}
