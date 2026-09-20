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
 * WHY A LINK AND NOT AN EMBED, EVEN HERE: the live view is Browserbase's
 * DevTools fullscreen inspector -- a dense developer UI, not a clean page
 * screencast. Checked: it sends no X-Frame-Options and no CSP frame-ancestors,
 * so embedding WOULD work. It is simply the wrong call for the job. The panel
 * lives inside a 460px-tall canvas, and that is not enough room to comfortably
 * read a login form, let alone type into one -- and typing into it is the
 * entire point of a handoff. A new tab gives it the full window.
 *
 * The trade is real and it is accepted: the person leaves the page for a
 * moment. That is worth it for a step they are being asked to perform by hand.
 * If passive WATCHING (agent works, nobody types) is wanted later, an embed is
 * the right shape for that and can sit next to this rather than replace it.
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

import type { Approval, BrowserSessionRecord, Iso, Step } from '@htn/shared';
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
  const decisions = steps.map(decisionOf).filter((d): d is StreamedDecision => d !== null);
  const live = !session.closedAt;
  const canEmbed = live && Boolean(session.liveViewUrl);
  const lastUrl = decisions.at(-1)?.url ?? session.startUrl ?? null;

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
          {canEmbed ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <span aria-hidden className="text-2xl">
                🖥
              </span>
              <p className="max-w-[30ch] text-[12px] leading-relaxed text-slate-300">
                The browser is open and waiting for you.
              </p>
              <a
                href={session.liveViewUrl}
                target="_blank"
                // noopener is the one that matters: without it the opened tab
                // gets a handle on this window via `window.opener`.
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-md bg-sky-500 px-3 py-1.5 text-sm font-medium text-slate-950 transition-colors hover:bg-sky-400"
              >
                Open live browser ↗
              </a>
              <p className="max-w-[32ch] text-[11px] leading-relaxed text-slate-600">
                Opens in a new tab at full size. Come back here and confirm when you are done — the
                run is holding this session open for you.
              </p>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
              <span aria-hidden className="text-2xl opacity-40">
                ▤
              </span>
              <p className="text-[12px] text-slate-400">
                {live ? 'This backend has no viewable session' : 'The session has ended'}
              </p>
              <p className="max-w-[28ch] text-[11px] leading-relaxed text-slate-600">
                {live
                  ? 'Local and mocked browsers never leave the machine, so there is nothing to open. The decisions are on the right.'
                  : 'A live view cannot be reopened after a session stops. What it did is on the right.'}
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
                {canEmbed
                  ? 'Open the browser, do it there, then come back and confirm.'
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
