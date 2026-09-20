/**
 * Canned graph documents for mock-mode synthesis.
 *
 * The mock has to return something a real synthesiser would return, not a stub
 * string -- the whole chat -> graph -> run loop has to work with zero API keys,
 * and it has to be DETERMINISTIC so a rehearsed demo is identical every time.
 *
 * TWO CONSTRAINTS THESE FIXTURES MUST KEEP:
 *
 *  1. Every tool name must exist in the toolbox catalog, or the run fails
 *     classification. See docs/tool-registry-handoff.md.
 *  2. Every fixture must leave something for runtime to decide -- at least one
 *     `dispatch` or `agent_task`. Otherwise the synthesis service's own
 *     delegation guard rejects the mock's output and mock mode can never
 *     succeed. That is intentional: the mock is held to the same bar as the
 *     model.
 */

interface GraphFixture {
  /** Lowercase keywords; first fixture with a hit wins. */
  match: string[];
  body: Record<string, unknown>;
}

const FIXTURES: GraphFixture[] = [
  {
    match: ['invoice', 'vendor', 'portal', 'overdue', 'billing'],
    body: {
      name: 'Vendor invoice sweep',
      description: 'Check vendor portals for overdue invoices, then report what was found.',
      nodes: [
        {
          id: 'collect',
          type: 'agent_task',
          label: 'Check vendor portals',
          position: { x: 0, y: 0 },
          config: {
            goal: 'Visit each vendor portal and list invoices that are past due.',
            availableTools: ['browser.navigate', 'browser.extract', 'web.search', 'docs.read'],
          },
        },
        {
          id: 'triage',
          type: 'judge',
          label: 'Anything overdue?',
          position: { x: 0, y: 130 },
          config: {
            question: 'Did the sweep find overdue invoices?',
            options: ['found_overdue', 'nothing_overdue'],
            evidence: '{{collect.result}}',
          },
        },
        {
          id: 'record',
          type: 'dispatch',
          label: 'Record the findings',
          position: { x: 0, y: 260 },
          config: {
            goal: 'Record the overdue invoice findings where the team will see them.',
            candidateTools: ['sheets.append', 'calendar.create', 'mail.send'],
            args: {
              'sheets.append': { row: '{{collect.result}}' },
              'calendar.create': { title: 'Review overdue invoices' },
              'mail.send': { subject: 'Overdue invoices found' },
            },
          },
        },
        {
          id: 'notify',
          type: 'submit',
          label: 'Email the summary',
          position: { x: 0, y: 390 },
          config: {
            tool: 'mail.send',
            args: { subject: 'Overdue invoice summary' },
            description: 'Send the overdue invoice summary by email?',
            actionKind: 'send_email',
          },
        },
      ],
      edges: [
        { id: 'e1', source: 'collect', target: 'triage' },
        { id: 'e2', source: 'triage', target: 'record', sourceHandle: 'found_overdue' },
        { id: 'e3', source: 'record', target: 'notify' },
      ],
    },
  },
  {
    match: ['summar', 'document', 'report', 'redact', 'pii', 'case'],
    body: {
      name: 'Summarise and file',
      description: 'Redact a document locally, summarise it in the cloud, then file the result.',
      nodes: [
        {
          id: 'load',
          type: 'fetch',
          label: 'Load the document',
          position: { x: 0, y: 0 },
          config: { source: 'local://document', text: '{{input.document}}' },
        },
        {
          id: 'scrub',
          type: 'redact',
          label: 'Pin sensitive data locally',
          position: { x: 0, y: 130 },
          config: { field: 'document', text: '{{load.text}}' },
        },
        {
          id: 'summarise',
          type: 'decide',
          label: 'Summarise (redacted)',
          position: { x: 0, y: 260 },
          config: { prompt: 'Summarise concisely:\n{{scrub.redacted}}', tier: 'cheap' },
        },
        {
          id: 'file',
          type: 'dispatch',
          label: 'File the summary',
          position: { x: 0, y: 390 },
          config: {
            goal: 'Put the summary somewhere the team can find it.',
            candidateTools: ['sheets.append', 'docs.draft', 'mail.send'],
            args: {
              'sheets.append': { row: '{{summarise.text}}' },
              'docs.draft': { body: '{{summarise.text}}' },
              'mail.send': { subject: 'Document summary' },
            },
          },
        },
      ],
      edges: [
        { id: 'e1', source: 'load', target: 'scrub' },
        { id: 'e2', source: 'scrub', target: 'summarise' },
        { id: 'e3', source: 'summarise', target: 'file' },
      ],
    },
  },
];

/** Used when nothing matches: still a real, runnable, delegating graph. */
const DEFAULT_FIXTURE: Record<string, unknown> = {
  name: 'Research and report',
  description: 'Investigate the request, decide what to do, and record the outcome.',
  nodes: [
    {
      id: 'investigate',
      type: 'agent_task',
      label: 'Investigate the request',
      position: { x: 0, y: 0 },
      config: {
        goal: 'Investigate the request and gather what is needed to act on it.',
        availableTools: ['browser.navigate', 'browser.extract', 'web.search', 'docs.read'],
      },
    },
    {
      id: 'decide',
      type: 'judge',
      label: 'Is action warranted?',
      position: { x: 0, y: 130 },
      config: {
        question: 'Do the findings justify taking action?',
        options: ['act', 'no_action'],
        evidence: '{{investigate.result}}',
      },
    },
    {
      id: 'act',
      type: 'dispatch',
      label: 'Take the appropriate action',
      position: { x: 0, y: 260 },
      config: {
        goal: 'Act on the findings using the most appropriate tool.',
        candidateTools: ['sheets.append', 'calendar.create', 'mail.send'],
        args: {
          'sheets.append': { row: '{{investigate.result}}' },
          'calendar.create': { title: 'Follow up' },
          'mail.send': { subject: 'Action required' },
        },
      },
    },
  ],
  edges: [
    { id: 'e1', source: 'investigate', target: 'decide' },
    { id: 'e2', source: 'decide', target: 'act', sourceHandle: 'act' },
  ],
};

/**
 * On an EDIT turn the prompt embeds the whole current graph, so matching the
 * raw prompt matches words from the existing document rather than from what
 * the user just asked for -- "invoice" in the embedded JSON beats "summarise"
 * in the request. Match the request only.
 *
 * synthesisPrompt.ts puts it after a "REQUEST: " marker.
 */
function requestPortion(prompt: string): string {
  const marker = prompt.lastIndexOf('REQUEST: ');
  return marker === -1 ? prompt : prompt.slice(marker + 'REQUEST: '.length);
}

/**
 * Deterministic keyword match. No randomness anywhere: the same request always
 * produces the same graph, which is what makes the demo rehearsable.
 *
 * NOTE: a fixture REPLACES the document rather than editing it. A real model
 * given the current graph will modify it in place; the mock cannot, so
 * conversational editing looks like a swap in mock mode. Worth knowing before
 * demoing an edit without keys.
 */
export function mockGraphFor(prompt: string): string {
  const haystack = requestPortion(prompt).toLowerCase();
  const hit = FIXTURES.find((fixture) => fixture.match.some((word) => haystack.includes(word)));
  return JSON.stringify(hit ? hit.body : DEFAULT_FIXTURE);
}
