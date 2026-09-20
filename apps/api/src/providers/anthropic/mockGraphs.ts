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
 * Self-improvement requests (see optimization.service.ts) are marked with a
 * literal `OPTIMIZE: ` prefix so the mock never mistakes one for a fresh
 * synthesis request and swaps in an unrelated fixture. buildSynthesisUserPrompt
 * embeds the current graph as a JSON blob right before the "REQUEST: " marker,
 * so it is parsed back out of the prompt here rather than threaded through a
 * new field on the model call -- keeps this change to one file.
 */
function extractCurrentGraphFromPrompt(prompt: string): Record<string, unknown> | null {
  const marker = prompt.lastIndexOf('REQUEST: ');
  const head = marker === -1 ? prompt : prompt.slice(0, marker);
  const start = head.indexOf('{');
  const end = head.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(head.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const DEFAULT_MAX_TOKENS = 2048;
/** A quarter off, never below a usable floor: 256 -> 1 would propose a broken node. */
const MAX_TOKENS_FACTOR = 0.75;
const MIN_MAX_TOKENS = 128;
const DEFAULT_MAX_DURATION_MS = 300_000;
const MAX_DURATION_STEP_MS = 60_000;
const MIN_MAX_DURATION_MS = 60_000;

/**
 * Exactly ONE small, deterministic tune -- never a fixture swap. Tries the
 * cheapest lever first: a `decide` node's tier, then its token budget, then an
 * `agent_task`'s time budget, and finally a no-op-looking description tweak so
 * there is always SOME visible diff even on a graph with neither node type.
 */
function applyOptimizeMutation(current: Record<string, unknown>): Record<string, unknown> {
  const nodes = Array.isArray(current.nodes) ? (current.nodes as Record<string, unknown>[]) : [];

  const decideNode = nodes.find((n) => n.type === 'decide');
  if (decideNode) {
    const config = { ...(decideNode.config as Record<string, unknown>) };
    if (config.tier !== 'cheap') {
      config.tier = 'cheap';
    } else {
      const maxTokens = typeof config.maxTokens === 'number' ? config.maxTokens : DEFAULT_MAX_TOKENS;
      config.maxTokens = Math.max(MIN_MAX_TOKENS, Math.round(maxTokens * MAX_TOKENS_FACTOR));
    }
    decideNode.config = config;
    return current;
  }

  const agentTaskNode = nodes.find((n) => n.type === 'agent_task');
  if (agentTaskNode) {
    const config = { ...(agentTaskNode.config as Record<string, unknown>) };
    const maxDurationMs =
      typeof config.maxDurationMs === 'number' ? config.maxDurationMs : DEFAULT_MAX_DURATION_MS;
    config.maxDurationMs = Math.max(MIN_MAX_DURATION_MS, maxDurationMs - MAX_DURATION_STEP_MS);
    agentTaskNode.config = config;
    return current;
  }

  const description = typeof current.description === 'string' ? current.description : '';
  return { ...current, description: description + ' (tuned)' };
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
  const request = requestPortion(prompt);

  if (request.trimStart().toUpperCase().startsWith('OPTIMIZE:')) {
    const current = extractCurrentGraphFromPrompt(prompt);
    if (current) return JSON.stringify(applyOptimizeMutation(current));
  }

  const haystack = request.toLowerCase();
  const hit = FIXTURES.find((fixture) => fixture.match.some((word) => haystack.includes(word)));
  return JSON.stringify(hit ? hit.body : DEFAULT_FIXTURE);
}
