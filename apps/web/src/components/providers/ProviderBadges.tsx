import type { ProviderStatus } from '@htn/shared';
import { Badge } from '../ui/Badge';

const DOT: Record<string, string> = {
  live: 'bg-emerald-400',
  mock: 'bg-sky-400',
};

/**
 * Shows which providers are live and which are mocked.
 *
 * Worth leaving on screen during judging: "these are live, these are mocked"
 * reads as rigour rather than as an unfinished project.
 *
 * `compact` is the nav strip: a coloured dot per provider (green live, blue
 * mock, grey off) instead of a full badge, so seven of them fit on one row.
 * The mode is still one hover away.
 */
export function ProviderBadges({
  providers,
  compact = false,
}: {
  providers: ProviderStatus[];
  compact?: boolean;
}) {
  if (providers.length === 0) return null;

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {providers.map((provider) => (
          <span
            key={provider.id}
            title={
              provider.id + ' — ' + provider.mode + (provider.detail ? ' · ' + provider.detail : '')
            }
            className="inline-flex items-center gap-1.5 text-[11px] text-slate-400"
          >
            <span
              className={'h-1.5 w-1.5 rounded-full ' + (DOT[provider.mode] ?? 'bg-slate-600')}
              aria-hidden
            />
            {provider.id}
            <span className="sr-only">{provider.mode}</span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {providers.map((provider) => (
        <Badge
          key={provider.id}
          tone={provider.mode === 'live' ? 'ok' : provider.mode === 'mock' ? 'accent' : 'muted'}
          title={provider.detail ?? provider.capabilities.join(', ')}
        >
          {provider.id}
          <span className="ml-1 opacity-60">{provider.mode}</span>
        </Badge>
      ))}
    </div>
  );
}
