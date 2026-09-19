import { useState } from 'react';
import type { Approval } from '@htn/shared';
import { api } from '../../lib/api';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

/**
 * The human half of the risk gate.
 *
 * Design rule: the proposed action is shown VERBATIM, never summarised. If a
 * person is being asked to authorise something irreversible, they get to see
 * exactly what would be sent.
 */
export function ApprovalPanel({ approval }: { approval: Approval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(true);
    setError(null);
    try {
      await api.decide(approval.id, { decision });
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
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warn">approval required</Badge>
        <Badge tone="bad">{approval.reversibility}</Badge>
        <span className="text-xs text-slate-500">{approval.policyRule}</span>
      </div>

      <p className="mt-2 text-sm text-slate-100">{approval.question}</p>

      <p className="mt-1 text-xs text-slate-500">
        This stopped because the action cannot be undone — not because a model was unsure.
      </p>

      <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-950/70 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
        {JSON.stringify(approval.proposedAction, null, 2)}
      </pre>

      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}

      <div className="mt-3 flex gap-2">
        <Button onClick={() => void decide('approved')} disabled={busy}>
          Approve and continue
        </Button>
        <Button variant="danger" onClick={() => void decide('rejected')} disabled={busy}>
          Reject
        </Button>
      </div>
    </div>
  );
}
