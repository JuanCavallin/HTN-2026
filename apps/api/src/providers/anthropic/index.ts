import type { Capability, TextModelAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveAnthropic } from './live.js';
import { estimateCostCents } from './pricing.js';
import { mockGraphFor } from './mockGraphs.js';

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
      const placeholders = (ctx.redactions ?? []).length;

      // A JSON request is graph synthesis. Returning prose here would make the
      // whole chat -> graph -> run loop unusable without API keys, so the mock
      // returns a real, runnable, DELEGATING document. See mockGraphs.ts.
      if (input.json) {
        const graph = mockGraphFor(input.prompt);
        const jsonIn = Math.ceil((input.prompt.length + (input.system?.length ?? 0)) / 4);
        const jsonOut = Math.ceil(graph.length / 4);
        return mockCall(
          'anthropic',
          'complete',
          cfg.mode,
          ctx,
          () => ({ text: graph, tokensIn: jsonIn, tokensOut: jsonOut }),
          {
            tokensIn: jsonIn,
            tokensOut: jsonOut,
            estimatedCostCents: estimateCostCents(input.tier ?? 'standard', jsonIn, jsonOut),
          },
        );
      }
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

      // Computed out here rather than inside `produce`, so the same numbers can
      // go on BOTH the data and the meta. meta is the half the egress ledger
      // reads; returning them only in data records nothing.
      const tokensIn = Math.ceil(input.prompt.length / 4);
      const tokensOut = Math.ceil(text.length / 4);

      return mockCall(
        'anthropic',
        'complete',
        cfg.mode,
        ctx,
        () => ({ text, tokensIn, tokensOut }),
        {
          tokensIn,
          tokensOut,
          estimatedCostCents: estimateCostCents(input.tier ?? 'standard', tokensIn, tokensOut),
        },
      );
    },
  };
}
