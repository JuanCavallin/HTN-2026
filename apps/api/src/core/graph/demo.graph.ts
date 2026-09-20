/**
 * The seeded demo graph — demo.playbook.ts, expressed as a document.
 *
 * It exists for three reasons:
 *   1. the canvas is not empty at t=0, which matters at a demo
 *   2. it proves the interpreter reproduces a run we already trust
 *   3. it exercises every executor family, so the visual legend has one of each
 *
 * Deliberately shaped so a screenshot shows the whole vocabulary at once:
 *
 *      load(program) -> redact(program) -> summary(model) -+-> followup(agent)
 *                                                          |        |
 *                                                          |        v
 *                                                          |    verify(swarm)
 *                                                          |        |
 *                                                          |        v
 *                                                          |    verdict(judge)
 *                                                          |     /        \
 *                                                          |  file(tool)  (none)
 *                                                          v
 *                                                    notify(dispatch, background)
 *
 * `notify` is the interesting one: a DISPATCH node running in parallel with the
 * expensive branch. The decision layer picks one tool from three candidates and
 * we call it directly — no agent harness, so one cheap call instead of a
 * multi-turn loop. Compare its token count to `followup` in the analytics
 * rollup; that gap is the argument for the middle rung.
 */

import type { AgentGraph } from '@htn/shared';

export const DEMO_GRAPH_ID = 'graph_demo';

/** The same fake case file demo.playbook.ts uses. The SIN is a test value. */
const CASE_FILE =
  'Case reference {{input.target}}. Applicant SIN 046 454 286, contact ' +
  'avery.chen@example.edu, phone 519-555-0142. Assessment shows three line items ' +
  'requiring independent verification before any correction is filed.';

export function buildDemoGraph(at: string): AgentGraph {
  return {
    id: DEMO_GRAPH_ID,
    name: 'Demo: verify and correct',
    description:
      'Loads a case file, pins its PII locally, summarises it in the cloud with placeholders only, ' +
      'verifies across sources in parallel, and stops for a human before filing anything.',
    version: 1,
    createdAt: at,
    updatedAt: at,
    nodes: [
      {
        id: 'load',
        type: 'fetch',
        label: 'Load case file',
        position: { x: 0, y: 0 },
        config: { source: 'local://case-file', text: CASE_FILE },
      },
      {
        id: 'redact',
        type: 'redact',
        label: 'Detect sensitive data (local)',
        position: { x: 0, y: 130 },
        config: { field: 'case_file', text: '{{load.text}}' },
      },
      {
        id: 'summary',
        type: 'decide',
        label: 'Summarise case (cloud, redacted)',
        position: { x: 0, y: 260 },
        config: {
          // Only the placeholder text leaves. {{redact.redacted}} is the
          // scrubbed copy; {{load.text}} would be the raw document.
          prompt: '{{redact.redacted}}',
          tier: 'cheap',
          maxTokens: 256,
        },
      },
      {
        id: 'notify',
        type: 'dispatch',
        label: 'Log the summary somewhere',
        position: { x: 340, y: 390 },
        // Fire-and-forget: a failure here is reported, not fatal.
        background: true,
        config: {
          goal: 'Record the case summary for later review.',
          candidateTools: ['sheets.append', 'calendar.create', 'mail.send'],
          args: {
            'sheets.append': { row: '{{summary.text}}' },
            'calendar.create': { title: 'Review case {{input.target}}' },
            'mail.send': { subject: 'Case summary {{input.target}}' },
          },
          argsFrom: 'static',
          evidence: 'The summary is already redacted; no raw values are in play.',
        },
      },
      {
        id: 'followup',
        type: 'agent_task',
        label: 'Delegate follow-up analysis',
        position: { x: 0, y: 390 },
        config: {
          goal: 'Given the case summary, identify what follow-up action, if any, is warranted.',
          /**
           * REAL REGISTRY IDS, not invented ones.
           *
           * The orchestrator resolves these through the trusted tool registry
           * (`toolRegistry.resolve`) and SILENTLY DROPS anything it does not
           * know. This list used to be provider-style names -- `web.search`,
           * `docs.read` -- that no longer register anywhere, so every one was
           * dropped, the harness started with an empty toolset, and Hermes fell
           * back to its own `browser_exec`, which fails. Measured before this
           * change: availableTools 0, exposedTools 0.
           *
           * Naming registry ids instead puts the call on the AgentOS path: Jev
           * selects from these, the selection becomes the turn's exposure grant,
           * and Hermes reaches them over the MCP gateway where the broker
           * enforces the grant. Its own tools are not an escape hatch from that.
           *
           * BOTH BACKENDS ARE LISTED ON PURPOSE. `eligibleTaskTools` filters by
           * the session's data labels, so a private task keeps only the local
           * browser while a public one may use either -- listing one backend
           * would decide that statically and defeat the routing.
           *
           * READ-ONLY ONLY. `submit` is irreversible and must never appear in an
           * unattended harness allowlist; `click`/`type` are left out because
           * this subtask is analysis, not form-filling.
           */
          availableTools: [
            'localbrowser.search',
            'localbrowser.open',
            'localbrowser.extract',
            'localbrowser.inspect',
            'browserbase.search',
            'browserbase.open',
            'browserbase.extract',
            'browserbase.inspect',
          ],
          harness: 'hermes',
        },
      },
      {
        id: 'verify',
        type: 'swarm',
        label: 'Verify across sources',
        position: { x: 0, y: 520 },
        config: {
          items: ['primary record system', 'secondary ledger', 'public rate table'],
          concurrency: 3,
          workerPrompt: 'Check {{item}} against the case summary and report anything inconsistent.',
        },
      },
      {
        id: 'verdict',
        type: 'judge',
        label: 'Adjudicate findings',
        position: { x: 0, y: 650 },
        config: {
          question: 'Do the findings justify filing a correction?',
          // options[0] is the branch worth showing: it reaches the approval
          // gate. The mock decision provider is deterministic and picks it.
          options: ['file_correction', 'no_action'],
          evidence: 'Verified {{verify.total}} source(s), {{verify.failed}} failed.',
        },
      },
      {
        id: 'file',
        type: 'submit',
        label: 'File correction request',
        position: { x: 0, y: 780 },
        config: {
          tool: 'forms.submit',
          args: { target: '{{input.target}}' },
          description: 'Submit a correction request for {{input.target}}?',
          amountCents: 4200,
          actionKind: 'submit_form',
        },
      },
    ],
    edges: [
      { id: 'e_load_redact', source: 'load', target: 'redact' },
      { id: 'e_redact_summary', source: 'redact', target: 'summary' },
      { id: 'e_summary_followup', source: 'summary', target: 'followup' },
      { id: 'e_summary_notify', source: 'summary', target: 'notify' },
      { id: 'e_followup_verify', source: 'followup', target: 'verify' },
      { id: 'e_verify_verdict', source: 'verify', target: 'verdict' },
      // Branch: only the file_correction verdict reaches the submit node. The
      // no_action branch has no edge, so `file` is skipped rather than run.
      { id: 'e_verdict_file', source: 'verdict', target: 'file', sourceHandle: 'file_correction' },
    ],
    assertions: [
      {
        id: 'a_verdict',
        description: 'The judge reached a verdict from its allowed options.',
        path: 'nodes.verdict.choice',
        expected: 'file_correction',
      },
      {
        id: 'a_pii',
        description: 'Sensitive spans were pinned locally rather than sent.',
        path: 'nodes.redact.spans',
        expected: '3',
      },
    ],
  };
}
