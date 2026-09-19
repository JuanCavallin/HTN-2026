/**
 * The built-in demo playbook. Deliberately generic — it is named after no product
 * idea, and it exists to exercise every part of the runtime with zero API keys:
 *
 *   sequential steps -> PII redaction -> a cloud call carrying only placeholders
 *   -> a parallel swarm -> a judge -> a blocking approval on an irreversible action
 *
 * USE THIS AS THE TEMPLATE. When the idea is final, copy this file, rename it,
 * write the real steps, and add one line to registry.ts.
 */

import { demoInputSchema, type DemoInput } from '@htn/shared';
import { successes } from '../swarm.js';
import { definePlaybook } from './types.js';

/** A fake case file. The SIN is a well-known test value and passes the Luhn check. */
function caseFile(target: string, includeSensitive: boolean): string {
  const sensitive = includeSensitive
    ? 'Applicant SIN 046 454 286, contact avery.chen@example.edu, phone 519-555-0142.'
    : 'Applicant contact withheld.';
  return (
    'Case reference ' +
    target +
    '. ' +
    sensitive +
    ' Assessment shows three line items ' +
    'requiring independent verification before any correction is filed.'
  );
}

const SOURCES = [
  'primary record system',
  'secondary ledger',
  'public rate table',
  'archived statement',
  'counterparty portal',
  'policy rules file',
  'prior-term snapshot',
  'notification history',
];

export const demoPlaybook = definePlaybook<DemoInput>({
  kind: 'demo',
  title: 'Demo run (mock end-to-end)',
  inputSchema: demoInputSchema,

  async execute(ctx, input) {
    await ctx.log('info', 'Starting demo run for ' + input.target);

    /* 1. Load the source document. -------------------------------------- */
    // The raw document stays in this closure. A step's `output` is emitted over
    // SSE and stored, so it must never carry unredacted content — return
    // metadata about the document, not the document.
    let raw = '';
    await ctx.step({ label: 'Load case file', kind: 'fetch' }, async () => {
      await sleep(400);
      raw = caseFile(input.target, input.includeSensitive);
      return { source: 'local://case-file', bytes: raw.length };
    });

    /* 2. Detect PII and pin it locally. --------------------------------- */
    const redaction = await ctx.step(
      { label: 'Detect sensitive data (local)', kind: 'redact' },
      async () => ctx.redact(raw, 'case_file'),
    );

    await ctx.log(
      'info',
      redaction.hadSensitive
        ? 'Pinned ' + redaction.redactions.length + ' sensitive span(s) to local processing.'
        : 'No sensitive data detected.',
    );

    /* 3. Cloud reasoning — placeholders only, never the values. ---------- */
    const summary = await ctx.step(
      { label: 'Summarise case (cloud model, redacted)', kind: 'decide', providerId: 'anthropic' },
      async (step) => {
        const model = ctx.provider('text.model');
        const res = await model.complete(
          { prompt: redaction.redacted, maxTokens: 256 },
          ctx.callContext({
            stepId: step.id,
            policyRule: 'redacted-payload-may-leave',
            redactions: redaction.redactions,
          }),
        );
        return res.ok ? res.data.text : 'Summary unavailable (' + res.error.code + ')';
      },
    );

    /* 4. Swarm: independent verification across N sources. --------------- */
    const targets = SOURCES.slice(0, input.workerCount);

    const outcomes = await ctx.fanOut<
      string,
      { source: string; finding: string; flagged: boolean }
    >({
      label: 'Verify across ' + targets.length + ' sources',
      items: targets,
      concurrency: targets.length,
      workerLabel: (source) => 'Check ' + source,
      worker: async (source, index, step) => {
        const browser = ctx.provider('browser');
        const session = await browser.openSession(
          {},
          ctx.callContext({ stepId: step.id, policyRule: 'read-only-public-source' }),
        );
        if (!session.ok) throw new Error('Could not open session: ' + session.error.message);

        const extracted = await browser.extract<{ note: string }>(
          { sessionId: session.data.sessionId, instruction: 'Read ' + source },
          ctx.callContext({ stepId: step.id, policyRule: 'read-only-public-source' }),
        );

        await browser.closeSession(
          session.data.sessionId,
          ctx.callContext({ stepId: step.id, policyRule: 'read-only-public-source' }),
        );

        return {
          source,
          finding: extracted.ok ? extracted.data.note : 'no data',
          // Deterministic so the demo is identical every time it is rehearsed.
          flagged: index % 2 === 0,
        };
      },
    });

    const findings = successes(outcomes);
    const flagged = findings.filter((f) => f.flagged);

    /* 5. Judge: adjudicate the independent findings. --------------------- */
    const verdict = await ctx.step(
      { label: 'Adjudicate findings', kind: 'judge', providerId: 'jev' },
      async (step) => {
        const decider = ctx.provider('decision');
        const res = await decider.decide(
          {
            question: 'Do the findings justify filing a correction?',
            options: ['file_correction', 'no_action'],
            evidence: flagged.length + ' of ' + findings.length + ' sources flagged.',
          },
          ctx.callContext({ stepId: step.id, policyRule: 'aggregate-no-pii' }),
        );
        return res.ok ? res.data : { choice: 'no_action', confidence: 0 };
      },
    );

    /* 6. The irreversible action. This is where the run stops for a human. */
    let filingStatus = 'not_required';

    if (verdict.choice === 'file_correction') {
      filingStatus = await ctx.step(
        { label: 'File correction request', kind: 'submit', providerId: 'composio' },
        async (step) => {
          // Classified irreversible -> creates an Approval and BLOCKS here.
          await ctx.requireApproval(step.id, {
            kind: 'submit_form',
            description:
              'Submit a correction request for ' +
              input.target +
              ' citing ' +
              flagged.length +
              ' flagged source(s)?',
            amountCents: 4200,
            payload: {
              target: input.target,
              flaggedSources: flagged.map((f) => f.source),
              amountCents: 4200,
            },
          });

          const toolbox = ctx.provider('toolbox');
          const res = await toolbox.callTool(
            { name: 'forms.submit', args: { target: input.target } },
            ctx.callContext({ stepId: step.id, policyRule: 'human-approved-submission' }),
          );
          return res.ok ? 'submitted' : 'submission_failed';
        },
      );
    }

    // One result shape for every branch. The UI renders it by run.kind, so a
    // stable shape is worth more than a minimal one.
    return {
      summary:
        filingStatus === 'not_required'
          ? 'No action needed for ' + input.target + '. ' + findings.length + ' sources checked.'
          : 'Filed a correction for ' +
            input.target +
            ' (' +
            flagged.length +
            ' of ' +
            findings.length +
            ' sources flagged). Status: ' +
            filingStatus +
            '.',
      result: {
        target: input.target,
        verdict: verdict.choice,
        confidence: verdict.confidence,
        summary,
        flaggedSources: flagged.map((f) => f.source),
        sourcesChecked: findings.length,
        sensitiveSpansPinnedLocally: redaction.redactions.length,
        filingStatus,
      },
    };
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
