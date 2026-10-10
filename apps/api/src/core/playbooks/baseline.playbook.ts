/**
 * The baseline playbook — the naive comparison point for the Compare view.
 *
 * ONE frontier-tier LLM call. No tools, no decomposition, no redaction gate.
 * That last part is deliberate, not an oversight: the raw case file (the
 * SAME text graph_demo and demo.playbook.ts use, via caseFile()) goes to the
 * model as-is. This is what "just ask the model to do it" actually looks
 * like, PII and all — the exact risk `redact` nodes exist to prevent. The
 * comparison view reads that gap straight from the egress ledger and PII
 * spans (0 for the baseline, several for the graph), no special-casing needed.
 *
 * The reply is asked for in the same {choice, confidence, rationale} shape a
 * `judge` node produces, specifically so it can be checked against the SAME
 * `graphAssertionSchema` expectations a graph run is checked against (see
 * evaluateAssertions in @htn/shared) — e.g. graph_demo's `a_verdict`
 * assertion expects `choice === "file_correction"`.
 */

import { baselineInputSchema, type BaselineInput } from '@htn/shared';
import { caseFile } from './demo.playbook.js';
import { definePlaybook } from './types.js';

interface BaselineVerdict {
  choice: string;
  /** Self-reported by the model, NOT calibrated like Jev's probabilities —
   *  label it as such anywhere it's shown next to a real confidence number. */
  confidence: number;
  rationale: string;
}

function parseVerdict(text: string): BaselineVerdict {
  try {
    const parsed = JSON.parse(text) as Partial<BaselineVerdict>;
    if (typeof parsed.choice === 'string') {
      return {
        choice: parsed.choice,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
        rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
      };
    }
  } catch {
    /* fall through to the failure shape below */
  }
  return {
    choice: 'no_action',
    confidence: 0,
    rationale: 'Could not parse a verdict from the model reply: ' + text.slice(0, 200),
  };
}

export const baselinePlaybook = definePlaybook<BaselineInput>({
  kind: 'baseline',
  title: 'Baseline (single LLM call, no graph)',
  inputSchema: baselineInputSchema,
  async execute(ctx, input) {
    await ctx.log('info', 'Running single-shot baseline for ' + input.target);

    const raw = caseFile(input.target, true);

    const verdict = await ctx.step(
      { label: 'Single LLM call (no tools, no graph, unredacted)', kind: 'decide' },
      async (step) => {
        const model = ctx.provider('text.model');
        const res = await model.complete(
          {
            system:
              'You handle the whole case yourself, end to end, in one reply. Reply with a ' +
              'single JSON object and nothing else: {"choice": "file_correction" | ' +
              '"no_action", "confidence": <0-1, your own self-reported confidence>, ' +
              '"rationale": <string>}.',
            prompt: raw,
            tier: 'frontier',
            maxTokens: 512,
            json: true,
          },
          // Intentionally NO `redactions` here -- nothing was redacted. The
          // policy rule names that plainly rather than dressing it up.
          ctx.callContext({ stepId: step.id, policyRule: 'baseline-single-call-unredacted' }),
        );
        if (!res.ok) throw new Error('Baseline model call failed: ' + res.error.message);
        return parseVerdict(res.data.text);
      },
    );

    return {
      summary: 'Baseline verdict for ' + input.target + ': ' + verdict.choice + '.',
      result: { target: input.target, ...verdict },
    };
  },
});
