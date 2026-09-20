/**
 * GPTZero — AI-content analysis.
 *
 * Where this earns its place: NOT as a detector on inbound content, but as a
 * self-check on OUTBOUND text — anything this system writes in the user's name
 * (to an insurer, a registrar, a support desk) gets scored before it sends, and
 * escalated to a human if it reads as machine-written.
 *
 * The live adapter is in live.ts; the policy wiring is in
 * core/tools/contentCheck.ts, which may only ever escalate. Mock mode returns a
 * deterministic low score so a keyless clone still exercises the whole path.
 */

import type { Capability, ContentAnalysisAdapter } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveGptzero } from './live.js';

const CAPABILITIES: readonly Capability[] = ['content.analysis'];

export function create(cfg: ProviderConfig): ContentAnalysisAdapter {
  if (cfg.mode === 'live' && cfg.apiKey) return createLiveGptzero(cfg);

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
