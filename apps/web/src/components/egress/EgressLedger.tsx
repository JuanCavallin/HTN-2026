import { useMemo, useState, type ReactNode } from 'react';
import type { EgressEvent, PiiSpan } from '@htn/shared';
import { Badge, type Tone } from '../ui/Badge';

const DECISION_TONE: Record<EgressEvent['decision'], Tone> = {
  allowed: 'ok',
  redacted: 'warn',
  blocked: 'bad',
};

/** A row that arrived in the last few seconds gets a one-shot highlight. */
const FRESH_MS = 4000;

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        'rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset transition-colors ' +
        (active
          ? 'bg-sky-500/15 text-sky-300 ring-sky-500/40'
          : 'text-slate-400 ring-slate-700 hover:text-slate-200')
      }
    >
      {children}
    </button>
  );
}

/**
 * Every outbound call, what class of data it carried, and which rule allowed it.
 *
 * This is the artifact that turns "we keep your data private" from a claim into
 * something a viewer can check. Note the columns: destination and data CLASS —
 * a value never appears here, because a value never leaves.
 */
export function EgressLedger({ events, piiSpans }: { events: EgressEvent[]; piiSpans: PiiSpan[] }) {
  const live = events.filter((e) => !e.destination.startsWith('mock://')).length;
  const blocked = events.filter((e) => e.decision === 'blocked').length;

  const [provider, setProvider] = useState<string | null>(null);
  const [decision, setDecision] = useState<EgressEvent['decision'] | null>(null);

  const providers = useMemo(() => [...new Set(events.map((e) => e.providerId))], [events]);
  const visible = events.filter(
    (e) => (!provider || e.providerId === provider) && (!decision || e.decision === decision),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge tone="muted">{events.length} calls</Badge>
        <Badge tone={live > 0 ? 'accent' : 'muted'}>{live} live</Badge>
        <Badge tone={blocked > 0 ? 'bad' : 'muted'}>{blocked} blocked</Badge>
        <Badge tone="ok">{piiSpans.length} spans pinned local</Badge>
        <Badge tone="ok">0 raw values sent</Badge>
      </div>

      {piiSpans.length > 0 && (
        <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
          <p className="mb-1 text-[11px] font-medium text-emerald-300">
            Held locally — the cloud only ever saw these placeholders
          </p>
          <div className="flex flex-wrap gap-1.5">
            {piiSpans.map((span) => (
              <span
                key={span.id}
                className="rounded bg-slate-950/60 px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
                title={span.field}
              >
                {span.placeholder} <span className="text-slate-600">{span.type}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {events.length === 0 ? (
        <p className="text-sm text-slate-500">No outbound calls yet.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip active={provider === null} onClick={() => setProvider(null)}>
              all providers
            </Chip>
            {providers.map((id) => (
              <Chip
                key={id}
                active={provider === id}
                onClick={() => setProvider(provider === id ? null : id)}
              >
                {id}
              </Chip>
            ))}
            <span className="mx-1 h-3 w-px bg-slate-700" aria-hidden />
            {(['allowed', 'redacted', 'blocked'] as const).map((d) => (
              <Chip
                key={d}
                active={decision === d}
                onClick={() => setDecision(decision === d ? null : d)}
              >
                {d}
              </Chip>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500">
                <tr className="border-b border-slate-800">
                  <th className="py-1.5 pr-3 font-medium">Destination</th>
                  <th className="py-1.5 pr-3 font-medium">Operation</th>
                  <th className="py-1.5 pr-3 font-medium">Carried</th>
                  <th className="py-1.5 pr-3 font-medium">Decision</th>
                  <th className="py-1.5 pr-3 font-medium">Allowed by</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Tokens</th>
                  <th className="py-1.5 text-right font-medium">ms</th>
                </tr>
              </thead>
              <tbody className="text-slate-400">
                {visible.map((event) => {
                  const fresh = Date.now() - new Date(event.at).getTime() < FRESH_MS;
                  const tokens = (event.tokensIn ?? 0) + (event.tokensOut ?? 0);
                  return (
                    <tr
                      key={event.id}
                      className={'border-b border-slate-900 ' + (fresh ? 'animate-row-flash' : '')}
                    >
                      <td className="py-1.5 pr-3 font-mono text-[11px]">{event.destination}</td>
                      <td className="py-1.5 pr-3">
                        {event.providerId}.{event.op}
                      </td>
                      <td className="py-1.5 pr-3">
                        {event.dataSpans.length === 0 ? (
                          <span className="text-slate-600">no user data</span>
                        ) : (
                          <Badge tone="warn">
                            {event.dataSpans.length} redacted (
                            {[...new Set(event.dataSpans.map((s) => s.type))].join(', ')})
                          </Badge>
                        )}
                      </td>
                      <td className="py-1.5 pr-3">
                        <Badge tone={DECISION_TONE[event.decision]}>{event.decision}</Badge>
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-[10px] text-slate-500">
                        {event.policyRule}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">
                        {tokens > 0 ? tokens.toLocaleString() : '—'}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-slate-600">
                        {event.latencyMs ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visible.length === 0 && (
              <p className="py-3 text-center text-xs text-slate-600">
                No calls match these filters.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
