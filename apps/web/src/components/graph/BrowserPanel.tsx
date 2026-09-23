/**
 * The live browser, docked inside the canvas.
 *
 * ============================================================================
 * WHY DOCKED AND NOT A MODAL: the canvas exists so a whole agentic process is
 * legible at once. A full-screen modal throws that away for the duration --
 * you stop being able to see that this browser belongs to the third node of
 * five. So the panel takes the right-hand side and the graph RECEDES rather
 * than disappearing, with the source node keeping its selected ring.
 *
 * WHY NOT AN IFRAME INSIDE THE NODE: NodeCard is 224px wide and carries three
 * deliberate marks (colour = who runs it, dashed = opaque, subtitle = the
 * concrete callee). A viewport at that size is unreadable AND would be a
 * fourth mark competing with three that already mean something.
 *
 * Browserbase's current debugger view is interactive. It is embedded only
 * during human handoff, when server-side ownership blocks agent calls.
 * Passive viewing while the agent owns the page needs a separate read-only stream.
 * The session stays tied to its resource in this panel; we refresh the signed
 * URL on demand so reconnects do not reload the viewer or create a new page.
 *
 * THE RIGHT-HAND COLUMN IS THE POINT. Anyone can screen-record a cursor moving
 * around a page. What almost nobody shows is the numbered element table the
 * decider actually saw, the integer it returned, its calibrated confidence,
 * and whether that answer cost a model call or was replayed from cache for
 * free. That is the difference between watching an agent and trusting one.
 *
 * NO LIVE VIEW IS A NORMAL STATE, not an error: localbrowser and every mock
 * return no URL at all, and Browserbase's debug URL returns 410 Gone the
 * moment the session stops. Both fall back to the decision trail, which is the
 * more informative artifact anyway -- so a MOCK_ALL=true rehearsal still shows
 * something real.
 * ============================================================================
 */

import { useEffect, useState } from 'react';
import type { Approval, BrowserSessionRecord, Iso, Step } from '@htn/shared';
import { api } from '../../lib/api';
import { Badge, type Tone } from '../ui/Badge';
import { Button } from '../ui/Button';

export type PanelSession = BrowserSessionRecord & { closedAt?: Iso };

/** The allowlisted fields interpreter.ts streams onto a browser tool's step. */
interface StreamedDecision {
  operation: string;
  index: number | null;
  target: string | null;
  url: string | null;
  navigated: boolean;
  decisionSource: string;
  confidence: number | null;
  rationale: string | null;
}

function decisionOf(step: Step): StreamedDecision | null {
  const output = step.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const decision = (output as Record<string, unknown>).decision;
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return null;
  return decision as unknown as StreamedDecision;
}

/**
 * Truthful labelling, per core/tools/browser.ts: a string match must not read
 * as a model decision, and a cache replay must not read as a live call. The
 * tone carries that distinction too -- `cache` is GOOD news (it was free), so
 * it is not the muted "nothing happened" grey.
 */
const SOURCE_TONE: Record<string, Tone> = {
  jev: 'accent',
  cache: 'ok',
  label: 'muted',
  deterministic: 'muted',
};

function sourceLabel(source: string): string {
  if (source === 'cache') return 'cache · 0 model calls';
  if (source === 'jev') return 'jev · 1 model call';
  return source;
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  // Low confidence is the interesting case: escalateForConfidence() re-gates a
  // coin flip up to ask_human, and this bar is the only place that shows the
  // coin flip that triggered it.
  const tone = value >= 0.8 ? 'bg-emerald-400' : value >= 0.5 ? 'bg-amber-400' : 'bg-rose-400';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-800">
        <div className={'h-full rounded-full ' + tone} style={{ width: pct + '%' }} />
      </div>
      <span className="font-mono text-[10px] tabular-nums text-slate-400">{value.toFixed(2)}</span>
    </div>
  );
}

function DecisionRow({ decision }: { decision: StreamedDecision }) {
  return (
    <li className="rounded border border-slate-800 bg-slate-950/60 px-2.5 py-2">
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[11px] font-medium text-sky-300">{decision.operation}</span>
        {decision.index !== null && (
          <span className="font-mono text-[11px] text-slate-500">[{decision.index}]</span>
        )}
        {decision.target && (
          <span className="truncate text-[11px] text-slate-200" title={decision.target}>
            {decision.target}
          </span>
        )}
      </div>

      {decision.confidence !== null && (
        <div className="mt-1.5">
          <ConfidenceBar value={decision.confidence} />
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-1.5">
        <Badge tone={SOURCE_TONE[decision.decisionSource] ?? 'muted'}>
          {sourceLabel(decision.decisionSource)}
        </Badge>
        {decision.navigated && <Badge tone="muted">navigated</Badge>}
      </div>

      {decision.rationale && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">{decision.rationale}</p>
      )}
    </li>
  );
}

export function BrowserPanel({
  session,
  steps,
  handoff,
  onResume,
  onClose,
  busy,
}: {
  session: PanelSession;
  /** Steps belonging to this session's node, in run order. */
  steps: Step[];
  /** The pending approval, when this session is parked on a handoff. */
  handoff?: Approval;
  onResume?: (approvalId: string) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const decisions = steps.map(decisionOf).filter((d): d is StreamedDecision => d !== null);
  const live = !session.closedAt;
  const canLoadViewer =
    live && Boolean(handoff) && session.providerId === 'browserbase' && session.interactive;
  const lastUrl = decisions.at(-1)?.url ?? session.startUrl ?? null;

  const refreshViewer = async () => {
    setViewerLoading(true);
    setViewerError(null);
    try {
      const result = await api.browserLiveView(session.runId, session.sessionId);
      if (!result.liveViewUrl || !result.interactive) {
        setViewerUrl(null);
        setViewerError('The session has no current interactive viewer.');
      } else {
        setViewerUrl(result.liveViewUrl);
      }
    } catch (err) {
      setViewerUrl(null);
      setViewerError((err as Error).message);
    } finally {
      setViewerLoading(false);
    }
  };

  useEffect(() => {
    if (!handoff) setViewerUrl(null);
  }, [handoff]);

  return (
    <aside className="pointer-events-auto absolute inset-y-0 right-0 z-10 flex w-[62%] min-w-[420px] flex-col border-l border-slate-700 bg-slate-950/95 shadow-2xl backdrop-blur">
      <header className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
        <span aria-hidden className="text-sm leading-none">
          🖥
        </span>
        <span className="text-[13px] font-medium text-slate-100">Browser</span>
        <Badge tone={session.providerId === 'localbrowser' ? 'ok' : 'accent'}>
          {session.providerId === 'localbrowser' ? 'local · never left' : session.providerId}
        </Badge>
        {live ? (
          <span className="flex items-center gap-1.5 text-[11px] text-sky-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
            live
          </span>
        ) : (
          <Badge tone="muted">session ended</Badge>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close browser panel"
          className="ml-auto rounded px-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
        >
          ×
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---- Left: the page itself, when there is one to show ---------- */}
        <div className="flex min-w-0 flex-1 flex-col border-r border-slate-800">
          {viewerUrl && handoff ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <iframe
                key={viewerUrl}
                src={viewerUrl}
                title="Interactive Browserbase session — human handoff"
                referrerPolicy="no-referrer"
                allow="clipboard-read; clipboard-write"
                className="min-h-0 flex-1 border-0 bg-white"
              />
              <div className="flex items-center justify-between gap-2 border-t border-slate-800 px-2.5 py-1.5">
                <span className="text-[10px] text-amber-300">
                  Human control · agent actions are paused
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void refreshViewer()}
                    disabled={viewerLoading}
                    className="text-[10px] text-sky-300 hover:text-sky-200 disabled:opacity-50"
                  >
                    {viewerLoading ? 'Refreshing…' : 'Refresh view'}
                  </button>
                  <a
                    href={viewerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-sky-300 hover:text-sky-200"
                  >
                    Open separately ↗
                  </a>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <span aria-hidden className="text-2xl opacity-40">
                ▤
              </span>
              <p className="max-w-[32ch] text-[12px] text-slate-300">
                {canLoadViewer
                  ? 'The agent has handed control of this browser to you.'
                  : live
                    ? 'This backend has no viewable session.'
                    : 'The session has ended.'}
              </p>
              {canLoadViewer && (
                <Button onClick={() => void refreshViewer()} disabled={viewerLoading}>
                  {viewerLoading ? 'Connecting…' : 'Show live browser here'}
                </Button>
              )}
              {viewerError && (
                <p className="max-w-[34ch] text-[11px] text-rose-300">{viewerError}</p>
              )}
              <p className="max-w-[32ch] text-[11px] leading-relaxed text-slate-600">
                {canLoadViewer
                  ? 'This live view can control the page, so it is available only during the human handoff. The viewer link is refreshed on demand.'
                  : live
                    ? 'Local and mocked browsers never leave the machine, so there is no remote viewer.'
                    : 'The live view cannot be reopened after a session stops.'}
              </p>
            </div>
          )}
          {lastUrl && (
            <div
              className="truncate border-t border-slate-800 px-2.5 py-1 font-mono text-[10px] text-slate-500"
              title={lastUrl}
            >
              {lastUrl}
            </div>
          )}
        </div>

        {/* ---- Right: why it did what it did ----------------------------- */}
        <div className="flex w-[46%] min-w-[210px] flex-col">
          {handoff && (
            <div className="border-b border-rose-500/30 bg-rose-500/5 px-3 py-2.5">
              <Badge tone="bad">you do this part</Badge>
              <p className="mt-1.5 text-[12px] leading-relaxed text-slate-100">
                {handoff.question}
              </p>
              <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
                {session.interactive
                  ? 'Use the embedded browser, then come back and confirm when you are done.'
                  : 'Do this in your own browser, then come back and confirm.'}{' '}
                Nothing you enter passes through this system — it is not read, not logged, and not
                sent to a model.
              </p>
              <div className="mt-2.5">
                <Button onClick={() => onResume?.(handoff.id)} disabled={busy}>
                  Done — continue
                </Button>
              </div>
            </div>
          )}

          <div className="border-b border-slate-800 px-3 py-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
              Decisions
            </span>
          </div>

          {decisions.length === 0 ? (
            <p className="px-3 py-3 text-[11px] leading-relaxed text-slate-600">
              No element-level actions yet. Each one records which element was chosen, how sure the
              decider was, and whether it cost a model call.
            </p>
          ) : (
            <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2.5 py-2">
              {decisions.map((decision, index) => (
                <DecisionRow key={index} decision={decision} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}
