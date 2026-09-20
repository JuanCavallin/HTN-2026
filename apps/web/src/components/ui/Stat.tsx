import type { ReactNode } from 'react';

/** Small labelled figure tile, used by the run header strip and the Home summary. */
export function Stat({
  label,
  children,
  tone = 'default',
}: {
  label: string;
  children: ReactNode;
  tone?: 'default' | 'ok' | 'warn' | 'bad';
}) {
  const value =
    tone === 'ok'
      ? 'text-emerald-300'
      : tone === 'warn'
        ? 'text-amber-300'
        : tone === 'bad'
          ? 'text-rose-300'
          : 'text-slate-100';

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div className={'mt-0.5 text-base font-semibold ' + value}>{children}</div>
    </div>
  );
}
