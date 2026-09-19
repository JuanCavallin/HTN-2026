import type { ProviderStatus } from '@htn/shared';
import { Badge } from '../ui/Badge';

/**
 * Shows which providers are live and which are mocked.
 *
 * Worth leaving on screen during judging: "these are live, these are mocked"
 * reads as rigour rather than as an unfinished project.
 */
export function ProviderBadges({ providers }: { providers: ProviderStatus[] }) {
  if (providers.length === 0) return null;

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
