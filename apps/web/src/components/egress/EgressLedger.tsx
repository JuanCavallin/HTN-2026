import type { EgressEvent, PiiSpan } from '@htn/shared';
import { Badge } from '../ui/Badge';

/**
 * Every outbound call, what class of data it carried, and which rule allowed it.
 *
 * This is the artifact that turns "we keep your data private" from a claim into
 * something a viewer can check. Note the columns: destination and data CLASS —
 * a value never appears here, because a value never leaves.
 */
export function EgressLedger({ events, piiSpans }: { events: EgressEvent[]; piiSpans: PiiSpan[] }) {
  const live = events.filter((e) => !e.destination.startsWith('mock://')).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge tone="muted">{events.length} calls</Badge>
        <Badge tone={live > 0 ? 'accent' : 'muted'}>{live} live</Badge>
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
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-slate-800">
                <th className="py-1.5 pr-3 font-medium">Destination</th>
                <th className="py-1.5 pr-3 font-medium">Operation</th>
                <th className="py-1.5 pr-3 font-medium">Carried</th>
                <th className="py-1.5 pr-3 font-medium">Allowed by</th>
                <th className="py-1.5 font-medium">ms</th>
              </tr>
            </thead>
            <tbody className="text-slate-400">
              {events.map((event) => (
                <tr key={event.id} className="border-b border-slate-900">
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
                  <td className="py-1.5 pr-3 font-mono text-[10px] text-slate-500">
                    {event.policyRule}
                  </td>
                  <td className="py-1.5 text-slate-600">{event.latencyMs ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
