/**
 * The graph page: pick a graph, see its shape, run it.
 *
 * Read-only in Phase 2 -- drag, connect and the node inspector arrive in
 * Phase 4. The node panel below is already the shell that inspector will fill,
 * so the layout does not have to change when editing lands.
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { styleOf, type GraphNode } from '@htn/shared';
import { useGraph, useGraphs } from '../hooks/useGraph';
import { api } from '../lib/api';
import { GraphCanvas } from '../components/graph/GraphCanvas';
import { Legend } from '../components/graph/Legend';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';

export function GraphEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { graphs } = useGraphs();
  const activeId = id ?? graphs[0]?.id;
  const { graph, error } = useGraph(activeId);

  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const launch = async () => {
    if (!graph) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const { run } = await api.runGraph(graph.id, { target: 'ACME-2026-TERM-FEES' });
      navigate('/runs/' + run.id);
    } catch (err) {
      setLaunchError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  };

  if (error) return <p className="text-sm text-rose-400">{error}</p>;

  if (!graph) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Spinner />
        Loading graph…
      </div>
    );
  }

  const selected = graph.nodes.find((n) => n.id === selectedNodeId);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-slate-100">{graph.name}</h1>
        <Badge tone="muted">v{graph.version}</Badge>
        <Badge tone="muted">{graph.nodes.length} nodes</Badge>
        <div className="ml-auto flex items-center gap-2">
          {graphs.length > 1 && (
            <select
              value={graph.id}
              onChange={(event) => navigate('/graphs/' + event.target.value)}
              className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-200"
            >
              {graphs.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          <Button onClick={() => void launch()} disabled={launching}>
            {launching ? 'Starting…' : 'Run graph'}
          </Button>
        </div>
      </div>

      {graph.description && <p className="text-sm text-slate-400">{graph.description}</p>}
      {launchError && <p className="text-xs text-rose-400">{launchError}</p>}

      <GraphCanvas
        graph={graph}
        selectedNodeId={selectedNodeId}
        onSelectNode={setSelectedNodeId}
        className="h-[560px]"
      />

      <Legend />

      <Card title={selected ? 'Node: ' + selected.label : 'Select a node'}>
        {selected ? (
          <NodeDetail node={selected} />
        ) : (
          <p className="text-sm text-slate-500">
            Click a node to see exactly what it calls. Editing arrives in Phase 4.
          </p>
        )}
      </Card>
    </div>
  );
}

function NodeDetail({ node }: { node: GraphNode }) {
  const style = styleOf(node.type);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{style.icon}</span>
        <Badge tone="accent">{style.label}</Badge>
        <span className="font-mono text-xs text-slate-400">{node.type}</span>
        {style.opaque && (
          <Badge tone="warn" title="This runtime's internal loop is not visible to us">
            opaque
          </Badge>
        )}
        {node.background && <Badge tone="muted">background</Badge>}
      </div>

      <p className="text-xs text-slate-500">{style.description}</p>

      <div>
        <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-600">config</div>
        <pre className="overflow-x-auto rounded bg-slate-950/60 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
          {JSON.stringify(node.config, null, 2)}
        </pre>
      </div>
    </div>
  );
}
