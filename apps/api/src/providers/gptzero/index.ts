/**
 * GPTZero — AI-content analysis. OUT OF SCOPE for now, by request.
 *
 * The slot exists so that turning it on later is a config change, not a refactor.
 * There is deliberately NO live.ts: set GPTZERO_MODE=mock to exercise the wiring,
 * and write live.ts when the capability is actually wanted.
 *
 * Where this earns its place when you do want it: NOT as a detector on inbound
 * content, but as a self-check on OUTBOUND text — anything this system writes in
 * the user's name (to an insurer, a registrar, a support desk) gets scored before
 * it sends, and rewritten if it reads as machine-written.
 */

import type { Capability, ContentAnalysisAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';

const CAPABILITIES: readonly Capability[] = ['content.analysis'];

export function create(cfg: ProviderConfig): ContentAnalysisAdapter {
  // No live adapter exists yet. 'live' falls through to the mock rather than
  // crashing the server, consistent with every other provider here.
  const base = mockBase('gptzero', CAPABILITIES, cfg.mode === 'live' ? 'mock' : cfg.mode);
  return {
    ...base,
    async analyze(input, ctx) {
      return mockCall('gptzero', 'analyze', base.mode, ctx, () => ({
        score: 0.12,
        label: input.text.length > 400 ? 'likely_human' : 'inconclusive',
      }));
    },
  };
}
