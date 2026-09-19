import type { ReactNode } from 'react';

export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'accent';

const TONES: Record<Tone, string> = {
  ok: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  warn: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  bad: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  muted: 'bg-slate-500/15 text-slate-400 ring-slate-500/30',
  accent: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
};

export function Badge({
  tone = 'muted',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
        TONES[tone]
      }
    >
      {children}
    </span>
  );
}
