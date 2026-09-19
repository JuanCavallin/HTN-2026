import type { Capability, TextModelAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveAnthropic } from './live.js';

const CAPABILITIES: readonly Capability[] = ['text.model'];

export function create(cfg: ProviderConfig): TextModelAdapter {
  if (cfg.mode === 'live') return createLiveAnthropic(cfg);
  return createMock(cfg);
}

function createMock(cfg: ProviderConfig): TextModelAdapter {
  const base = mockBase('anthropic', CAPABILITIES, cfg.mode);
  return {
    ...base,
    async complete(input, ctx) {
      return mockCall('anthropic', 'complete', cfg.mode, ctx, () => {
        const placeholders = (ctx.redactions ?? []).length;
        // Echoing the placeholder count proves, in the demo, that what reached the
        // "cloud" model was the redacted text and not the values.
        const text =
          'Mock summary (tier=' +
          (input.tier ?? 'standard') +
          ') of a ' +
          input.prompt.length +
          '-char prompt containing ' +
          placeholders +
          ' redacted span(s). Three line items require verification.';
        return {
          text,
          tokensIn: Math.ceil(input.prompt.length / 4),
          tokensOut: Math.ceil(text.length / 4),
        };
      });
    },
  };
}
