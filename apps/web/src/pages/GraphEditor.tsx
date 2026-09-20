/**
 * The graph page: see a workflow's shape, edit it, run it.
 *
 * A manual graph editor. You build and edit the DOCUMENT directly on the
 * canvas, and only then launch it -- a prompt box that immediately executes
 * would be a different (and less defensible) thing.
 *
 * Phase 4: the canvas is directly editable here (drag, connect, delete) and
 * the node panel is a real typed form (NodeInspector) instead of a read-only
 * JSON dump. Every canvas mutation carries `graph.version` -- see the
 * mutation error banner below for what happens when two edits race.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AgentGraph, GraphEdge, GraphNodeType } from '@htn/shared';
import { GRAPH_NODE_TYPES } from '@htn/shared';
import { useGraph, useGraphs } from '../hooks/useGraph';
import { useTools } from '../hooks/useTools';
import { api, ApiError } from '../lib/api';
import { newClientId } from '../lib/ids';
import { GraphCanvas } from '../components/graph/GraphCanvas';
import { Legend } from '../components/graph/Legend';
import { NodeInspector } from '../components/graph/NodeInspector';
import { buildDefaultNode, defaultLabelFor } from '../components/graph/nodeDefaults';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';

export function GraphEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { graphs, refresh: refreshGraphs, error: graphListError } = useGraphs();
  const { graph: loaded, refresh: refreshGraph } = useGraph(id ?? undefined);
  const { tools } = useTools();

  // The displayed document is local state seeded from whatever was loaded.
  const [graph, setGraph] = useState<AgentGraph | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [addType, setAddType] = useState<GraphNodeType>('tool');
  // A 409 here means a concurrent edit won -- see mutateGraph's
  // optimistic-concurrency check.
  const [mutationError, setMutationError] = useState<string | null>(null);

  useEffect(() => {
    if (loaded) setGraph(loaded);
  }, [loaded]);

  // With no graph in the URL, show the most recent one so the canvas is not
  // empty while nothing has been edited yet.
  useEffect(() => {
    if (!id && !graph && graphs.length > 0) setGraph(graphs[0] as AgentGraph);
  }, [id, graph, graphs]);

  const DEMO_TARGET = 'ACME-2026-TERM-FEES';

  const launch = async () => {
    if (!graph) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const { run } = await api.runGraph(graph.id, { target: DEMO_TARGET });
      navigate('/runs/' + run.id);
    } catch (err) {
      setLaunchError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  };

  const launchWithBaseline = async () => {
    if (!graph) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      // Both POSTs fire before either is awaited -- genuinely parallel, not
      // one blocking the other -- so the baseline's latency never adds to
      // the graph run's, and vice versa.
      const [{ run: graphRun }, { run: baselineRun }] = await Promise.all([
        api.runGraph(graph.id, { target: DEMO_TARGET }),
        api.createRun('baseline', { target: DEMO_TARGET, graphId: graph.id }),
      ]);
      navigate('/compare?a=' + graphRun.id + '&b=' + baselineRun.id);
    } catch (err) {
      setLaunchError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  };

  // Explicit, so it never gets confused with "no :id in the URL yet" -- that
  // case defaults to the most recent task (see the effect above) rather than
  // starting a blank one. This is the only path that intentionally wants blank.
  const startNewTask = async () => {
    setCreating(true);
    setLaunchError(null);
    try {
      const { graph: created } = await api.createGraph({});
      await refreshGraphs();
      navigate('/graphs/' + created.id);
    } catch (err) {
      setLaunchError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  function reportMutationError(err: unknown) {
    setMutationError(err instanceof Error ? err.message : String(err));
  }

  const addNode = async () => {
    if (!graph) return;
    // A loose grid so a run of adds doesn't stack nodes exactly on top of
    // each other; the user drags from here into whatever shape they want.
    const position = {
      x: 80 + (graph.nodes.length % 4) * 220,
      y: 80 + Math.floor(graph.nodes.length / 4) * 140,
    };
    const node = buildDefaultNode(
      addType,
      position,
      tools.map((t) => t.name),
    );
    try {
      const { graph: next } = await api.addNode(graph.id, node, graph.version);
      setGraph(next);
      setSelectedNodeId(node.id);
      setMutationError(null);
    } catch (err) {
      reportMutationError(err);
    }
  };

  const moveNode = async (nodeId: string, position: { x: number; y: number }) => {
    if (!graph) return;
    try {
      const { graph: next } = await api.patchNode(graph.id, nodeId, { position }, graph.version);
      setGraph(next);
      setMutationError(null);
    } catch (err) {
      reportMutationError(err);
      // The dragged position is already showing locally; pull the server's
      // truth back down rather than leaving the canvas out of sync with it.
      void refreshGraph();
    }
  };

  const connectNodes = async (source: string, target: string) => {
    if (!graph) return;
    const edge: GraphEdge = { id: newClientId('edge'), source, target };
    try {
      const { graph: next } = await api.addEdge(graph.id, edge, graph.version);
      setGraph(next);
      setMutationError(null);
    } catch (err) {
      reportMutationError(err);
    }
  };

  const deleteNode = async (nodeId: string) => {
    if (!graph) return;
    try {
      const { graph: next } = await api.removeNode(graph.id, nodeId, graph.version);
      setGraph(next);
      if (selectedNodeId === nodeId) setSelectedNodeId(undefined);
      setMutationError(null);
    } catch (err) {
      reportMutationError(err);
    }
  };

  const deleteEdge = async (edgeId: string) => {
    if (!graph) return;
    try {
      const { graph: next } = await api.removeEdge(graph.id, edgeId, graph.version);
      setGraph(next);
      setMutationError(null);
    } catch (err) {
      // Deleting a node cascades to its edges server-side. Selecting a node
      // and pressing delete fires both this and deleteNode for the same
      // gesture, so the edge side of that race landing a 409 (the node's
      // delete already bumped the version and dropped the edge) is the
      // expected outcome, not a real conflict -- nothing to show for it.
      if (err instanceof ApiError && err.status === 409) return;
      reportMutationError(err);
    }
  };

  const selected = graph?.nodes.find((n) => n.id === selectedNodeId);

  return (
    <div className="editor-workspace space-y-5">
      <div className="editor-toolbar flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-slate-100">{graph?.name ?? 'New workflow'}</h1>
        {graph && <Badge tone="muted">v{graph.version}</Badge>}
        {graph && <Badge tone="muted">{graph.nodes.length} nodes</Badge>}
        <div className="ml-auto flex items-center gap-2">
          {graphs.length > 0 && (
            <select
              value={graph?.id ?? ''}
              onChange={(event) => navigate('/graphs/' + event.target.value)}
              title="Switch task"
              className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-200"
            >
              {graphs.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          <Button variant="ghost" onClick={() => void startNewTask()} disabled={creating}>
            {creating ? 'Creating…' : '+ New task'}
          </Button>
          {graph && (
            <>
              <select
                value={addType}
                onChange={(event) => setAddType(event.target.value as GraphNodeType)}
                className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-200"
              >
                {GRAPH_NODE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {defaultLabelFor(type)}
                  </option>
                ))}
              </select>
              <Button variant="ghost" onClick={() => void addNode()}>
                + Add node
              </Button>
            </>
          )}
          <Button onClick={() => void launch()} disabled={launching || !graph}>
            {launching ? 'Starting…' : 'Run graph'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => void launchWithBaseline()}
            disabled={launching || !graph}
          >
            Run + compare to baseline
          </Button>
        </div>
      </div>

      {graphListError && (
        <div className="notice editor-offline" role="status">
          The workflow API is unavailable. Start the backend to load or edit saved workflows.{' '}
          <button className="text-link" onClick={() => void refreshGraphs()}>
            Try again
          </button>
        </div>
      )}
      {graph?.description && <p className="text-sm text-slate-400">{graph.description}</p>}
      {launchError && <p className="text-xs text-rose-400">{launchError}</p>}
      {mutationError && (
        <p className="text-xs text-rose-400">
          {mutationError}{' '}
          <button
            type="button"
            onClick={() => {
              setMutationError(null);
              void refreshGraph();
            }}
            className="underline underline-offset-2 hover:text-rose-300"
          >
            reload graph
          </button>
        </p>
      )}

      <div className="editor-layout">
        {graph ? (
          <GraphCanvas
            graph={graph}
            editable
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onMoveNode={(nodeId, position) => void moveNode(nodeId, position)}
            onConnectNodes={(source, target) => void connectNodes(source, target)}
            onDeleteNode={(nodeId) => void deleteNode(nodeId)}
            onDeleteEdge={(edgeId) => void deleteEdge(edgeId)}
            className="h-[560px]"
          />
        ) : (
          <div className="flex h-[560px] items-center justify-center rounded-lg border border-dashed border-slate-800 text-sm text-slate-600">
            Start a new task to build a workflow.
          </div>
        )}
      </div>

      <Legend />

      <Card title={selected ? 'Node: ' + selected.label : 'Select a node'}>
        {selected && graph ? (
          <NodeInspector
            // Every field below is an uncontrolled input seeded via
            // defaultValue -- remount on node switch so it doesn't keep
            // showing the previously-selected node's typed-but-unblurred text.
            key={selected.id}
            graph={graph}
            node={selected}
            tools={tools}
            onPatched={(next) => {
              setGraph(next);
              setMutationError(null);
            }}
            onDeleted={(next) => {
              setGraph(next);
              setSelectedNodeId(undefined);
              setMutationError(null);
            }}
            onError={reportMutationError}
          />
        ) : (
          <p className="text-sm text-slate-500">
            Click a node to edit it, drag to reposition, or drag from its bottom handle to a target
            node to connect them.
          </p>
        )}
      </Card>
    </div>
  );
}
