import { useState } from 'react';
import type { Approval, ApprovalDecision } from '@htn/shared';
import { api } from '../../lib/api';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

/**
 * The human half of the risk gate.
 *
 * Design rule: the proposed action is shown VERBATIM, never summarised. If a
 * person is being asked to authorise something irreversible, they get to see
 * exactly what would be sent.
 *
 * Three answers, not two. "Revise" edits the exact payload and sends it back
 * for reauthorization -- the server re-runs the risk gate on the edit and
 * refuses it (422) if it broadens the action, so this textarea is a narrowing
 * control, not a way around the gate. A refused revision leaves the approval
 * pending, which is why the panel stays open and editable on that error.
 */
export function ApprovalPanel({ approval }: { approval: Approval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  const submit = async (decision: ApprovalDecision) => {
    setBusy(true);
    setError(null);
    try {
      await api.decide(approval.id, decision);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitRevision = async () => {
    let revisedPayload: unknown;
    try {
      revisedPayload = JSON.parse(draft ?? '');
    } catch {
      // Caught here rather than sent: a payload that is not JSON cannot be
      // classified, and the gate would reject it with a far less useful message.
      setError('That is not valid JSON, so it cannot be reauthorized. Fix it and try again.');
      return;
    }
    await submit({ decision: 'revised', revisedPayload });
  };

  if (approval.status !== 'pending') {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <Badge
            tone={
              approval.status === 'approved' ? 'ok' : approval.status === 'revised' ? 'warn' : 'bad'
            }
          >
            {approval.status}
          </Badge>
          <span className="text-sm text-slate-400">{approval.question}</span>
        </div>

        {/* Both survive on the record: what was asked for, and what ran. */}
        {approval.status === 'revised' && (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Proposed</p>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-950/70 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
                {JSON.stringify(approval.proposedAction, null, 2)}
              </pre>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">
                Executed (reauthorized
                {approval.reauthorizedRule ? ': ' + approval.reauthorizedRule : ''})
              </p>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-950/70 px-3 py-2 text-[11px] leading-relaxed text-slate-300">
                {JSON.stringify(approval.revisedAction, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    );
  }

  const revising = draft !== null;

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

      {revising ? (
        <>
          <textarea
            className="mt-2 h-48 w-full resize-y rounded bg-slate-950/70 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-200 outline-none ring-1 ring-slate-800 focus:ring-amber-500/50"
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
          />
          <p className="mt-1 text-xs text-slate-500">
            The edit goes back through the risk gate. It may narrow the action; a revision that
            makes it riskier is refused and the action stays pending.
          </p>
        </>
      ) : (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-950/70 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
          {JSON.stringify(approval.proposedAction, null, 2)}
        </pre>
      )}

      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        {revising ? (
          <>
            <Button onClick={() => void submitRevision()} disabled={busy}>
              Send revised payload
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
              Cancel edit
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => void submit({ decision: 'approved' })} disabled={busy}>
              Approve and continue
            </Button>
            <Button
              variant="ghost"
              onClick={() => setDraft(JSON.stringify(approval.proposedAction, null, 2))}
              disabled={busy}
            >
              Revise payload
            </Button>
            <Button
              variant="danger"
              onClick={() => void submit({ decision: 'rejected' })}
              disabled={busy}
            >
              Reject
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
