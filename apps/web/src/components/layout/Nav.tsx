import { Link } from 'react-router-dom';
import { useProviders } from '../../hooks/useRuns';
import { ProviderBadges } from '../providers/ProviderBadges';

export function Nav() {
  const providers = useProviders();

  return (
    <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
        <Link to="/" className="text-sm font-semibold tracking-tight text-slate-100">
          Agent Runtime
          <span className="ml-2 font-normal text-slate-600">HTN 2026</span>
        </Link>
        <div className="ml-auto">
          <ProviderBadges providers={providers} />
        </div>
      </div>
    </header>
  );
}
