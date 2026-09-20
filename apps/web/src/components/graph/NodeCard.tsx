/**
 * One graph node, on the canvas.
 *
 * The job of this component is to make an agentic process legible at a glance,
 * so three marks do most of the work and none of them is decorative:
 *
 *   COLOUR  = who runs it (executor family, from @htn/shared)
 *   DASHED  = we cannot see inside it (only the agent harness)
 *   SUBTITLE= the concrete thing being called: a tool name, a model tier, a
 *             harness id. "Show the tools, programs and agents explicitly"
 *             means naming them, not just colouring a box.
 *
 * During a run it also carries live status and, once the run has produced
 * metrics, a token count -- so the expensive node is visibly expensive. An
 * agent-class node additionally shows exposed-vs-called tool counts, flagging
 * any tool the harness called that Jev never suggested -- restriction on the
 * harness is best-effort, not enforced (see hermes/live.ts), so this is the
 * one place that gap is actually visible rather than silently trusted.
 */

import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  executorOf,
  styleOf,
  type GraphNode,
  type NodeMetrics,
  type StepStatus,
} from '@htn/shared';
import { EXECUTOR_CLASSES, STATUS_RING } from './palette';

export interface NodeCardData extends Record<string, unknown> {
  node: GraphNode;
  status?: StepStatus;
  metrics?: NodeMetrics;
  selected?: boolean;
  onOpen?: (nodeId: string) => void;
  /** Canvas is in edit mode (GraphEditor, not a live/past run view). */
  editable?: boolean;
  onDelete?: (nodeId: string) => void;
}

/** The concrete callee, so the canvas names real things rather than categories. */
function subtitleFor(node: GraphNode): string | null {
  switch (node.type) {
    case 'tool':
    case 'submit':
      return node.config.tool;
    case 'dispatch':
      return node.config.candidateTools.length + ' candidates → 1';
    case 'decide':
      return node.config.tier ? node.config.tier + ' tier' : 'standard tier';
    case 'agent_task':
      return (
        (node.config.harness ?? 'agent.runtime') +
        ' · ' +
        node.config.availableTools.length +
        ' tools'
      );
    case 'swarm':
      return node.config.items.length + ' workers';
    case 'judge':
      return node.config.options.join(' | ');
    case 'fetch':
      return node.config.source;
    case 'approval':
      return 'blocks for a human';
    default:
      return null;
  }
}

function tokens(metrics?: NodeMetrics): number {
  if (!metrics) return 0;
  return metrics.tokensIn + metrics.tokensOut;
}

export function NodeCard({ data }: NodeProps) {
  const { node, status, metrics, selected, onOpen, editable, onDelete } = data as NodeCardData;
  const style = styleOf(node.type);
  const classes = EXECUTOR_CLASSES[executorOf(node.type)];

  const total = tokens(metrics);
  const subtitle = subtitleFor(node);

  return (
    <div
      onDoubleClick={() => onOpen?.(node.id)}
      className={
        'w-56 rounded-lg border px-3 py-2 text-left transition-shadow ' +
        classes.shell +
        ' ' +
        (status ? (STATUS_RING[status] ?? '') : '') +
        (selected ? ' ring-2 ring-white/60' : '')
      }
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-slate-500" />

      <div className="mb-1 flex items-center gap-1.5">
        <span aria-hidden className="text-sm leading-none">
          {style.icon}
        </span>
        <span
          className={
            'rounded-full px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ' +
            classes.chip
          }
        >
          {style.label}
        </span>
        {status === 'running' && (
          <span className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
        )}
        {status === 'blocked' && (
          <span className="ml-auto text-[10px] text-amber-300">waiting</span>
        )}
        {editable && !status && (
          <button
            type="button"
            title="Delete node"
            aria-label="Delete node"
            onClick={(event) => {
              event.stopPropagation();
              onDelete?.(node.id);
            }}
            className="ml-auto rounded px-1 text-[11px] leading-none text-slate-500 hover:bg-rose-500/20 hover:text-rose-300"
          >
            ×
          </button>
        )}
      </div>

      <div className="truncate text-[13px] font-medium text-slate-100" title={node.label}>
        {node.label}
      </div>

      {subtitle && (
        <div className="mt-0.5 truncate font-mono text-[10px] text-slate-400" title={subtitle}>
          {subtitle}
        </div>
      )}

      {metrics && (
        <div className="mt-1.5 flex items-center gap-2 border-t border-white/5 pt-1 text-[10px] text-slate-400">
          <span className={total === 0 ? 'text-emerald-400' : ''}>
            {total === 0 ? 'free' : total + ' tok'}
          </span>
          {metrics.llmCalls > 0 && <span>{metrics.llmCalls} calls</span>}
          <span className="ml-auto">{(metrics.wallMs / 1000).toFixed(1)}s</span>
        </div>
      )}

      {metrics?.calledToolNames && (
        <div
          className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-500"
          title={
            'Exposed: ' +
            (metrics.exposedToolNames?.join(', ') || 'none') +
            '\nCalled: ' +
            metrics.calledToolNames.join(', ')
          }
        >
          <span>
            {metrics.toolsExposed ?? 0} exposed · {metrics.calledToolNames.length} called
          </span>
          {metrics.toolDivergence && metrics.toolDivergence.length > 0 && (
            <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 py-px font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30">
              ⚠ {metrics.toolDivergence.length} not suggested
            </span>
          )}
        </div>
      )}

      {node.background && (
        <div className="mt-1 text-[10px] text-slate-500">background · failure not fatal</div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2 !w-2 !border-0 !bg-slate-500"
      />
    </div>
  );
}
