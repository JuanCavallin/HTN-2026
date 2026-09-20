import type { ModelRoute, TextModelAdapter } from '@htn/shared';

/**
 * Logical routes backed by the currently-bound text model capability. OpenRouter
 * can replace this catalog later without changing the gateway or Hermes wiring.
 */
export function modelRoutesFor(adapter: TextModelAdapter): ModelRoute[] {
  if (adapter.mode !== 'live') {
    return [
      {
        id: 'bound-text-model-local-cheap',
        providerId: adapter.id,
        modelId: 'mock-local-cheap',
        costTier: 'cheap',
        deployment: 'local',
        contextScope: 'local_only',
        supportsTools: false,
        allowedDataLabels: ['public', 'private', 'secret', 'local_only'],
        enabled: true,
        noTraining: true,
        zeroDataRetention: true,
      },
    ];
  }

  return (['cheap', 'standard', 'frontier'] as const).map((costTier) => ({
    id: 'bound-text-model-cloud-' + costTier,
    providerId: adapter.id,
    modelId: 'bound-' + costTier,
    costTier,
    deployment: 'cloud' as const,
    contextScope: 'public' as const,
    supportsTools: false,
    // Until provider-specific retention policy is represented, only explicitly
    // public state can use this cloud bridge.
    allowedDataLabels: ['public'] as const,
    enabled: true,
  }));
}
