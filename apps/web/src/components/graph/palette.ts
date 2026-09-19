/**
 * Executor colour -> concrete Tailwind classes.
 *
 * WHY A LOOKUP AND NOT `border-${color}-500`: Tailwind scans source for literal
 * class names. An interpolated class is never emitted, so a dynamically built
 * name silently renders unstyled. Every class here has to appear as a literal.
 *
 * The colour FAMILY per executor lives in @htn/shared (executors.ts) so the API
 * and the canvas agree on the taxonomy; only the rendering lives here.
 */

import { EXECUTOR_STYLE, type NodeExecutor } from '@htn/shared';

export interface ExecutorClasses {
  /** Node container: border + background. */
  shell: string;
  /** The small executor chip in the node header. */
  chip: string;
  /** Edge/handle accent. */
  stroke: string;
  /** Legend swatch. */
  dot: string;
}

export const EXECUTOR_CLASSES: Record<NodeExecutor, ExecutorClasses> = {
  program: {
    shell: 'border-slate-600 bg-slate-800/70',
    chip: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
    stroke: '#94a3b8',
    dot: 'bg-slate-400',
  },
  tool: {
    shell: 'border-emerald-500/50 bg-emerald-950/40',
    chip: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    stroke: '#34d399',
    dot: 'bg-emerald-400',
  },
  decision: {
    shell: 'border-amber-500/50 bg-amber-950/30',
    chip: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
    stroke: '#fbbf24',
    dot: 'bg-amber-400',
  },
  model: {
    shell: 'border-violet-500/50 bg-violet-950/30',
    chip: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
    stroke: '#a78bfa',
    dot: 'bg-violet-400',
  },
  agent: {
    // Dashed, and deliberately the most washed-out shell on the canvas: we
    // cannot see inside this one. See EXECUTOR_STYLE.opaque.
    shell: 'border-zinc-500/60 bg-zinc-800/40 border-dashed',
    chip: 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30',
    stroke: '#a1a1aa',
    dot: 'bg-zinc-400',
  },
  human: {
    shell: 'border-rose-500/60 bg-rose-950/30',
    chip: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
    stroke: '#fb7185',
    dot: 'bg-rose-400',
  },
  group: {
    shell: 'border-sky-500/50 bg-sky-950/30',
    chip: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
    stroke: '#38bdf8',
    dot: 'bg-sky-400',
  },
};

/** Status ring drawn on top of the executor shell during a run. */
export const STATUS_RING: Record<string, string> = {
  running: 'ring-2 ring-sky-400/70 shadow-[0_0_18px_-2px] shadow-sky-500/40',
  succeeded: 'ring-1 ring-emerald-400/50',
  failed: 'ring-2 ring-rose-400/70',
  blocked: 'ring-2 ring-amber-400/80 shadow-[0_0_18px_-2px] shadow-amber-500/40',
  pending: '',
  skipped: 'opacity-40',
};

export const EXECUTOR_ORDER: NodeExecutor[] = [
  'program',
  'tool',
  'decision',
  'model',
  'agent',
  'group',
  'human',
];

export function executorLabel(executor: NodeExecutor): string {
  return EXECUTOR_STYLE[executor].label;
}
