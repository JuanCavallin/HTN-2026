/**
 * The graph page: describe a workflow, see its shape, run it.
 *
 * Chat and canvas sit side by side on purpose. The chat produces a DOCUMENT,
 * not a run -- you read what it built, and only then launch it. That gap is the
 * product; a prompt box that immediately executes would be a different (and
 * less defensible) thing.
 *
 * Drag, connect and the node inspector arrive in Phase 4. The node panel below
 * is already the shell that inspector will fill.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { styleOf, type AgentGraph, type Conversation, type GraphNode } from '@htn/shared';
import { useGraph, useGraphs } from '../hooks/useGraph';
import { api } from '../lib/api';
import { ChatPanel } from '../components/chat/ChatPanel';
import { GraphCanvas } from '../components/graph/GraphCanvas';
import { Legend } from '../components/graph/Legend';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';

export function GraphEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { graphs, refresh: refreshGraphs } = useGraphs();
  const { graph: loaded } = useGraph(id ?? undefined);

  // The chat can replace the graph under us, so the displayed document is local
  // state seeded from whatever was loaded.
  const [graph, setGraph] = useState<AgentGraph | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  useEffect(() => {
    if (loaded) setGraph(loaded);
  }, [loaded]);

  // With no graph in the URL, show the most recent one so the canvas is not
  // empty while the chat is still untouched.
  useEffect(() => {
    if (!id && !graph && graphs.length > 0) setGraph(graphs[0] as AgentGraph);
  }, [id, graph, graphs]);

  // A DELIBERATE navigation to a different graph (the dropdown, or a link from
  // elsewhere) must drop any active conversation. Without this, an existing
  // conversation keeps the `graphId` it was seeded with, and a message typed
  // after switching would silently edit the graph you navigated AWAY from
  // while the canvas shows the one you switched TO. This does not fire when
  // the chat itself updates `graph` in place -- only when the URL's :id changes.
  useEffect(() => {
    setConversation(null);
  }, [id]);

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

  const selected = graph?.nodes.find((n) => n.id === selectedNodeId);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-slate-100">{graph?.name ?? 'New workflow'}</h1>
        {graph && <Badge tone="muted">v{graph.version}</Badge>}
        {graph && <Badge tone="muted">{graph.nodes.length} nodes</Badge>}
        <div className="ml-auto flex items-center gap-2">
          {graphs.length > 0 && (
            <select
              value={graph?.id ?? ''}
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
          <Button onClick={() => void launch()} disabled={launching || !graph}>
            {launching ? 'Starting…' : 'Run graph'}
          </Button>
        </div>
      </div>

      {graph?.description && <p className="text-sm text-slate-400">{graph.description}</p>}
      {launchError && <p className="text-xs text-rose-400">{launchError}</p>}

      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <ChatPanel
          conversation={conversation}
          graphId={graph?.id}
          onConversation={setConversation}
          onGraph={(next) => {
            setGraph(next);
            setSelectedNodeId(undefined);
            void refreshGraphs();
          }}
          className="h-[560px]"
        />

        {graph ? (
          <GraphCanvas
            graph={graph}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            className="h-[560px]"
          />
        ) : (
          <div className="flex h-[560px] items-center justify-center rounded-lg border border-dashed border-slate-800 text-sm text-slate-600">
            Describe a workflow to build one.
          </div>
        )}
      </div>

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
