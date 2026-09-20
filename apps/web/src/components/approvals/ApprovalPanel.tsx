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
 *
 * TWO KINDS OF STOP LIVE HERE, and the difference is the whole point:
 *
 *   ordinary approval  "may the agent do this?"  -> Approve / Reject
 *   handoff            "you do this part"        -> a link, then Done
 *
 * A handoff (interpreter.ts's runHandoff) is an approval mechanically -- same
 * blocking promise, same decide endpoint -- but asking someone to "approve"
 * their own typing is nonsense, so the wording and the controls change. The
 * SESSION IS ALREADY OPEN and the run is holding it; all this has to do is
 * hand over the URL.
 */
export function ApprovalPanel({
  approval,
  handoffSessionId,
}: {
  approval: Approval;
  /**
   * The browser session a handoff is parked on, when there is one.
   *
   * DELIBERATELY NOT A URL. Browserbase signs its viewer with a short-lived
   * token, so a URL handed down through props is already stale by the time
   * anyone clicks it -- it opens a blank page that accepts no input, which is
   * exactly the bug this replaced. The id is stable; the URL is fetched on
   * click. Undefined is normal (local and mocked browsers have no viewer).
   */
  handoffSessionId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  /**
   * Mint a viewer URL and open it. The window is opened FIRST, synchronously,
   * because a popup opened inside an await is a popup the browser blocks.
   */
  const openLiveView = async () => {
    setOpening(true);
    setError(null);
    const tab = window.open('', '_blank', 'noopener,noreferrer');
    try {
      const { liveViewUrl } = await api.browserLiveView(approval.runId, handoffSessionId as string);
      if (!liveViewUrl) {
        tab?.close();
        setError('That browser session is no longer viewable. It may have already closed.');
        return;
      }
      if (tab) tab.location.href = liveViewUrl;
      else window.open(liveViewUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      tab?.close();
      setError((err as Error).message);
    } finally {
      setOpening(false);
    }
  };

  // Set by runHandoff's proposedAction. Matching on `kind` rather than on the
  // presence of a URL keeps the handoff wording correct even when no viewable
  // session exists -- the person still has to go and do the thing.
  const action = approval.proposedAction;
  const isHandoff =
    !!action &&
    typeof action === 'object' &&
    !Array.isArray(action) &&
    (action as Record<string, unknown>).kind === 'human_handoff';

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

  if (isHandoff) {
    return (
      <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="bad">you do this part</Badge>
          <span className="text-xs text-slate-500">the agent never performs this step</span>
        </div>

        <p className="mt-2 text-sm text-slate-100">{approval.question}</p>

        {handoffSessionId ? (
          <>
            <button
              type="button"
              onClick={() => void openLiveView()}
              disabled={opening}
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-sky-500 px-3 py-1.5 text-sm font-medium text-slate-950 transition-colors hover:bg-sky-400 disabled:bg-slate-700 disabled:text-slate-500"
            >
              {opening ? 'Opening…' : 'Open live browser ↗'}
            </button>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              Opens in a new tab at full size. The run is holding this session open — do what you
              need to, then come back and confirm.
            </p>
          </>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-amber-400/90">
            This backend has no viewable session, so there is nothing to open. Do this in your own
            browser, then confirm.
          </p>
        )}

        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          Nothing you enter passes through this system — it is not read, not logged, and not sent to
          a model.
        </p>

        {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}

        {/* Short labels on purpose: the redesigned run view puts this in a
            narrow conversation lane, and "Done — continue" / "Skip and fail
            the run" both wrapped mid-word there. The consequence of skipping
            is spelled out in the line above rather than crammed into a button. */}
        <p className="mt-3 text-xs text-slate-500">
          Skipping fails the run — the agent will not attempt this itself.
        </p>
        <div className="mt-2 flex gap-2">
          <Button onClick={() => void decide('approved')} disabled={busy}>
            I&rsquo;m done
          </Button>
          <Button variant="danger" onClick={() => void decide('rejected')} disabled={busy}>
            Skip
          </Button>
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
