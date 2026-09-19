/**
 * The run list, kept fresh by the single global SSE stream rather than polling.
 * Home and RunDetail therefore open at most two connections in total.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ProviderStatus, Run } from '@htn/shared';
import { api } from '../lib/api';

export function useRuns() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { runs: list } = await api.listRuns();
      setRuns(list);
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

  // Global stream: any run.updated anywhere refreshes the list.
  useEffect(() => {
    const source = new EventSource('/api/stream');
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as { type: string };
        if (event.type === 'run.updated') void refresh();
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => source.close();
  }, [refresh]);

  return { runs, loading, error, refresh };
}

export function useProviders() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);

  useEffect(() => {
    api
      .providers()
      .then((res) => setProviders(res.providers))
      .catch(() => setProviders([]));
  }, []);

  return providers;
}

export function usePlaybooks() {
  const [playbooks, setPlaybooks] = useState<{ kind: string; title: string }[]>([]);

  useEffect(() => {
    api
      .playbooks()
      .then((res) => setPlaybooks(res.playbooks))
      .catch(() => setPlaybooks([]));
  }, []);

  return playbooks;
}
