import assert from 'node:assert/strict';
import type { DecisionState, ProviderCallContext, ToolSelectionDecision } from '@htn/shared';
import {
  buildToolShortlist,
  selectToolsForTask,
  shortlistConnectedToolkits,
} from '../src/core/tools/selection.js';
import {
  TOOL_SELECTION_GOLDEN_CASES,
  candidatesFor,
} from './fixtures/tool-selection-quality.fixtures.js';

const context: ProviderCallContext = {
  runId: 'tool_selection_quality',
  stepId: 'golden_suite',
  policyRule: 'golden-tool-selection-evaluation',
};

function state(taskSummary: string): DecisionState {
  return {
    taskSummary,
    dataLabels: ['public'],
    sanitizedForRemote: true,
  };
}

function decisionPort(
  decide: (candidateIds: string[]) => ToolSelectionDecision,
  calls: { count: number },
) {
  return {
    async selectTools(
      _state: DecisionState,
      candidates: ReturnType<typeof candidatesFor>,
      _context: ProviderCallContext,
    ): Promise<ToolSelectionDecision> {
      calls.count += 1;
      return decide(candidates.map((candidate) => candidate.id));
    },
  };
}

for (const golden of TOOL_SELECTION_GOLDEN_CASES) {
  const candidates = candidatesFor(golden);
  const shortlist = buildToolShortlist(golden.task, candidates);
  const shortlistedIds = shortlist.candidates.map((candidate) => candidate.descriptor.id);

  assert.equal(
    shortlist.intent.requiresTool,
    golden.requiresExternalTool,
    `${golden.name}: external-tool intent mismatch`,
  );
  for (const capability of golden.expectedCapabilities) {
    assert.ok(
      shortlist.intent.requiredCapabilities.includes(capability),
      `${golden.name}: missing capability ${capability}`,
    );
  }
  assert.ok(shortlistedIds.length <= 12, `${golden.name}: shortlist is not bounded`);
  for (const forbiddenId of golden.forbiddenIds) {
    assert.ok(
      !shortlistedIds.includes(forbiddenId),
      `${golden.name}: incompatible tool ${forbiddenId} entered the shortlist`,
    );
  }

  if (golden.expectNoCompatibleTool) {
    assert.deepEqual(shortlistedIds, [], `${golden.name}: expected no compatible candidate`);
  } else if (golden.expectedSelectedId) {
    assert.equal(
      shortlistedIds[0],
      golden.expectedSelectedId,
      `${golden.name}: deterministic ranking chose the wrong first candidate`,
    );
  } else {
    assert.deepEqual(shortlistedIds, [], `${golden.name}: no-tool task received candidates`);
  }

  const jevCalls = { count: 0 };
  const selected = await selectToolsForTask({
    state: state(golden.task),
    candidates,
    decisions: decisionPort(
      (candidateIds) => ({
        selectedToolIds: candidateIds.slice(0, 1),
        confidences: Object.fromEntries(candidateIds.map((id, index) => [id, 0.95 - index * 0.01])),
        reasonCodes: ['golden-jev-selection'],
      }),
      jevCalls,
    ),
    context,
  });
  assert.equal(
    jevCalls.count,
    shortlistedIds.length > 0 ? 1 : 0,
    `${golden.name}: expected exactly one Jev decision for a non-empty shortlist`,
  );
  assert.deepEqual(
    selected.selected.map((descriptor) => descriptor.id),
    shortlistedIds.slice(0, 1),
    `${golden.name}: selected tool escaped the deterministic shortlist`,
  );

  if (golden.expectedSelectedId) {
    const emptyCalls = { count: 0 };
    const recovered = await selectToolsForTask({
      state: state(golden.task),
      candidates,
      decisions: decisionPort(
        () => ({
          selectedToolIds: [],
          confidences: {},
          reasonCodes: ['golden-jev-returned-empty'],
        }),
        emptyCalls,
      ),
      context,
    });
    assert.equal(emptyCalls.count, 1, `${golden.name}: fallback path skipped Jev unexpectedly`);
    assert.deepEqual(
      recovered.selected.map((descriptor) => descriptor.id),
      [golden.expectedSelectedId],
      `${golden.name}: compatible fallback did not recover the expected tool`,
    );
    assert.equal(recovered.source, 'fallback', `${golden.name}: recovery source was not recorded`);
    assert.ok(
      recovered.reasonCodes.includes('deterministic-compatible-tool-recovery-fallback'),
      `${golden.name}: recovery reason was not recorded`,
    );
  }
}

const toolkitShortlist = shortlistConnectedToolkits(
  'fetch all emails i have recieved in the lasr 24 hours',
  [
    {
      slug: 'gmail',
      name: 'Gmail',
      authSchemes: ['OAUTH2'],
      connected: true,
      noAuth: false,
    },
    {
      slug: 'googlecalendar',
      name: 'Google Calendar',
      authSchemes: ['OAUTH2'],
      connected: true,
      noAuth: false,
    },
    {
      slug: 'github',
      name: 'GitHub',
      authSchemes: ['OAUTH2'],
      connected: true,
      noAuth: false,
    },
  ],
);
assert.deepEqual(
  toolkitShortlist.map((toolkit) => toolkit.slug),
  ['gmail'],
  'the failed typo-heavy Gmail prompt must deterministically retrieve the Gmail toolkit',
);

const tightenedCalls = { count: 0 };
const tightened = await selectToolsForTask({
  task: 'fetch all emails i have received in the last 24 hours',
  state: {
    taskSummary: 'Local-only objective withheld.',
    dataLabels: ['public', 'private', 'local_only'],
    sanitizedForRemote: false,
  },
  candidates: candidatesFor(TOOL_SELECTION_GOLDEN_CASES[0]!),
  decisions: decisionPort(
    (candidateIds) => ({
      selectedToolIds: candidateIds,
      confidences: Object.fromEntries(candidateIds.map((id) => [id, 1])),
      reasonCodes: ['must-not-run'],
    }),
    tightenedCalls,
  ),
  context,
});
assert.equal(tightenedCalls.count, 0, 'policy-ineligible tools must be removed before Jev');
assert.deepEqual(tightened.selected, [], 'fallback must not restore a policy-ineligible tool');
assert.equal(tightened.intent.requiresTool, true, 'local intent must survive remote redaction');
assert.deepEqual(tightened.intent.requiredCapabilities, ['email.read', 'email.search']);
assert.ok(tightened.reasonCodes.includes('policy-ineligible-tool-candidate'));

console.log(
  `Tool-selection quality checks passed (${TOOL_SELECTION_GOLDEN_CASES.length} golden cases).`,
);
