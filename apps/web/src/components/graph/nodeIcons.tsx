/**
 * One lucide icon per node type, replacing the emoji in @htn/shared's
 * NODE_TYPE_ICON on the web side. The shared strings stay as the fallback, so
 * a node type added there without an entry here still renders a mark.
 */

import {
  Bot,
  CircleDot,
  Download,
  EyeOff,
  Network,
  Scale,
  Send,
  ShieldAlert,
  Sparkles,
  Split,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { NODE_TYPE_ICON } from '@htn/shared';

const ICONS: Record<string, LucideIcon> = {
  fetch: Download,
  redact: EyeOff,
  tool: Wrench,
  submit: Send,
  dispatch: Split,
  judge: Scale,
  decide: Sparkles,
  agent_task: Bot,
  approval: ShieldAlert,
  swarm: Network,
  worker: CircleDot,
};

export function NodeIcon({
  type,
  className = 'h-3.5 w-3.5',
}: {
  type: string;
  className?: string;
}) {
  const Icon = ICONS[type];
  if (!Icon) {
    const fallback = (NODE_TYPE_ICON as Record<string, string>)[type] ?? '▸';
    return (
      <span aria-hidden className="leading-none">
        {fallback}
      </span>
    );
  }
  return <Icon aria-hidden className={className} strokeWidth={2} />;
}
