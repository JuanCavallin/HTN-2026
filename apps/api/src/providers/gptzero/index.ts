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

/**
 * Stock LLM throat-clearing. Presence of these is what the mock keys on.
 *
 * A mock that always returned a low score made the escalation UNDEMOABLE
 * without a key: the interesting half of this feature — a send stopping for a
 * human — could never be shown. This keeps the mock DETERMINISTIC (the repo
 * relies on a rehearsed demo looking the same every time) while still letting
 * obviously machine-written text trip the gate.
 */
const MACHINE_TELLS = [
  'thank you for reaching out',
  'i hope this email finds you',
  'i wanted to follow up',
  'please do not hesitate',
  'additional context',
  'for your consideration',
  'at your earliest convenience',
  'i appreciate your patience',
  'delve into',
  'it is worth noting',
];

/** Deterministic: same text always yields the same score. */
function mockScore(text: string): { score: number; label: string } {
  const haystack = text.toLowerCase();
  const hits = MACHINE_TELLS.filter((tell) => haystack.includes(tell)).length;

  if (hits === 0) {
    return { score: 0.12, label: text.length > 400 ? 'likely_human' : 'inconclusive' };
  }
  // Two or more tells reads as generated; one is ambiguous. Capped below 1 so
  // nothing downstream can mistake the mock for a calibrated certainty.
  return hits >= 2 ? { score: 0.93, label: 'ai' } : { score: 0.55, label: 'mixed' };
}

export function create(cfg: ProviderConfig): ContentAnalysisAdapter {
  if (cfg.mode === 'live' && cfg.apiKey) return createLiveGptzero(cfg);

  const base = mockBase('gptzero', CAPABILITIES, cfg.mode === 'live' ? 'mock' : cfg.mode);
  return {
    ...base,
    async analyze(input, ctx) {
      return mockCall('gptzero', 'analyze', base.mode, ctx, () => mockScore(input.text));
    },
  };
}
