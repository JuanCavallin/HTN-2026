import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import type { Approval } from '@htn/shared';
import { api } from '../../lib/api';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { JsonView } from '../ui/JsonView';

/**
 * The human half of the risk gate.
 *
 * Design rule: the proposed action is shown VERBATIM, never summarised. If a
 * person is being asked to authorise something irreversible, they get to see
 * exactly what would be sent.
 *
 * Deliberately NO keyboard shortcut for "approve": with several approvals
 * pending, one stray keypress must never authorise an irreversible action.
 */
export function ApprovalPanel({ approval }: { approval: Approval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(true);
    setError(null);
    try {
      await api.decide(approval.id, { decision });
      toast(decision === 'approved' ? 'Approved — run continuing' : 'Rejected');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (approval.status !== 'pending') {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <Badge tone={approval.status === 'approved' ? 'ok' : 'bad'}>{approval.status}</Badge>
          <span className="text-sm text-slate-400">{approval.question}</span>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      className="halo sticky top-2 z-20 rounded-xl border border-amber-500/50 bg-amber-950/60 px-4 py-3 shadow-lg shadow-black/40 backdrop-blur"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-300" aria-hidden />
        <Badge tone="warn">approval required</Badge>
        <Badge tone="bad">{approval.reversibility}</Badge>
        <span className="font-mono text-xs text-slate-500">{approval.policyRule}</span>
      </div>

      <p className="mt-2 text-sm font-medium text-slate-100">{approval.question}</p>

      <p className="mt-1 text-xs text-slate-400">
        This stopped because the action cannot be undone — not because a model was unsure.
      </p>

      <div className="mt-2">
        <JsonView value={approval.proposedAction} className="max-h-48" />
      </div>

      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}

      <div className="mt-3 flex gap-2">
        <Button onClick={() => void decide('approved')} disabled={busy}>
          Approve and continue
        </Button>
        <Button variant="danger" onClick={() => void decide('rejected')} disabled={busy}>
          Reject
        </Button>
      </div>
    </motion.div>
  );
}
