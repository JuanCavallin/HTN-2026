import { NavLink } from 'react-router-dom';
import { Presentation, Search, Workflow } from 'lucide-react';
import { useProviders } from '../../hooks/useRuns';
import { ProviderBadges } from '../providers/ProviderBadges';

const LINKS = [
  { to: '/', label: 'Runs', end: true },
  { to: '/graphs', label: 'Graphs', end: false },
];

export function Nav({
  widthClass,
  onOpenPalette,
  present,
  onTogglePresent,
}: {
  widthClass: string;
  onOpenPalette: () => void;
  present: boolean;
  onTogglePresent: () => void;
}) {
  const providers = useProviders();

  return (
    <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/75 backdrop-blur-md">
      <div className={'mx-auto flex w-full flex-wrap items-center gap-4 px-4 py-2.5 ' + widthClass}>
        <NavLink
          to="/"
          className="flex items-center gap-2 text-sm font-semibold tracking-tight text-slate-100"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-500/30">
            <Workflow className="h-3.5 w-3.5" aria-hidden />
          </span>
          Agent Runtime
          <span className="font-normal text-slate-600">HTN 2026</span>
        </NavLink>

        <nav className="flex items-center gap-1">
          {LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors ' +
                (isActive
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200')
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        <button
          type="button"
          onClick={onOpenPalette}
          className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900/70 px-2.5 py-1 text-xs text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200"
        >
          <Search className="h-3 w-3" aria-hidden />
          Search
          <kbd className="rounded bg-slate-800 px-1 font-mono text-[10px] text-slate-400">
            Ctrl K
          </kbd>
        </button>

        <button
          type="button"
          onClick={onTogglePresent}
          aria-pressed={present}
          title="Presentation mode: larger UI for demos"
          className={
            'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ' +
            (present
              ? 'border-sky-500/50 bg-sky-500/15 text-sky-300'
              : 'border-slate-700 bg-slate-900/70 text-slate-400 hover:border-slate-600 hover:text-slate-200')
          }
        >
          <Presentation className="h-3 w-3" aria-hidden />
          Present
        </button>

        <div className="ml-auto">
          <ProviderBadges providers={providers} compact />
        </div>
      </div>
    </header>
  );
}
