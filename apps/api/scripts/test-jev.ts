import type { ProviderCallContext, SessionCheckpoint } from '@htn/shared';
import { config } from '../src/config.js';
import { createLiveJev } from '../src/providers/jev/live.js';

const ctx: ProviderCallContext = {
  runId: 'jev_connection_test',
  stepId: 'jev_connection_test_step',
  policyRule: 'local-developer-connection-test',
};

function fail(message: string): never {
  throw new Error(message);
}

async function main(): Promise<void> {
  const providerConfig = config.providers.jev;
  if (providerConfig.mode !== 'live') {
    fail('Jev is not in live mode. Set JEV_MODE=live in the root .env file.');
  }
  if (!providerConfig.apiKey) {
    fail('No Gateway key found. Set AI_GATEWAY_API_KEY in the root .env file.');
  }

  const jev = createLiveJev(providerConfig);

  console.log('1. Checking Vercel AI Gateway authentication...');
  const health = await jev.health();
  if (!health.ok) fail(`${health.error.code}: ${health.error.message}`);
  console.log(`   PASS: ${health.data.detail ?? 'Gateway reachable'}`);

  console.log('2. Testing a typed Jev decision...');
  const decision = await jev.decide(
    {
      question: 'What should the support workflow do next?',
      options: ['auto_resolve', 'ask_human', 'deny'],
      evidence:
        'The request asks to permanently delete a customer account and cannot be automatically undone.',
    },
    ctx,
  );
  if (!decision.ok) fail(`${decision.error.code}: ${decision.error.message}`);
  if (!['auto_resolve', 'ask_human', 'deny'].includes(decision.data.choice)) {
    fail(`Jev returned an unexpected choice: ${decision.data.choice}`);
  }
  console.log(
    `   PASS: choice=${decision.data.choice} confidence=${decision.data.confidence.toFixed(3)}`,
  );

  console.log('3. Testing model and tool routing...');
  const availableTools = [
    'browser.search',
    'browser.open',
    'browser.extract',
    'mail.send',
    'forms.submit',
    'filesystem.read',
  ];
  const route = await jev.route(
    {
      task: 'Research a public company and summarize information from its website without sending messages.',
      availableTools,
      context: 'The work is read-only and uses public data.',
    },
    ctx,
  );
  if (!route.ok) fail(`${route.error.code}: ${route.error.message}`);
  if (route.data.exposedTools.some((tool) => !availableTools.includes(tool))) {
    fail('Jev returned a tool that was not in the candidate allowlist.');
  }
  console.log(
    `   PASS: privacy=${route.data.privacy} intelligence=${route.data.intelligence} ` +
      `tier=${route.data.modelTier} tools=${JSON.stringify(route.data.exposedTools)} ` +
      `confidence=${route.data.confidence.toFixed(3)}`,
  );

  console.log('4. Testing completion judgment...');
  const checkpoint: SessionCheckpoint = {
    runId: ctx.runId,
    objective: 'Identify the warranted follow-up action.',
    sanitizedObjective: 'Identify the warranted follow-up action.',
    steps: [
      {
        id: 'hermes_turn',
        label: 'Hermes analysis',
        status: 'succeeded',
        required: true,
        sanitizedSummary: 'Hermes produced the requested analysis.',
      },
    ],
    artifacts: [
      {
        id: 'analysis',
        kind: 'harness_result',
        required: true,
        verified: true,
        dataLabels: ['public'],
        sanitizedSummary: 'The required analysis artifact is present and verified.',
      },
    ],
    verifications: [
      { id: 'result_present', passed: true, required: true, reasonCode: 'result-present' },
    ],
    outstandingRequirements: [],
    pendingApprovalIds: [],
    dataLabels: ['public'],
    budget: { stepsRemaining: 2 },
    at: new Date().toISOString(),
  };
  const completion = await jev.judgeCompletion(
    {
      checkpoint,
      sanitizedState: {
        taskSummary: checkpoint.sanitizedObjective!,
        contextSummary:
          'Hermes produced the requested analysis. The required artifact is verified.',
        dataLabels: ['public'],
        sanitizedForRemote: true,
      },
    },
    ctx,
  );
  if (!completion.ok) fail(`${completion.error.code}: ${completion.error.message}`);
  console.log(
    `   PASS: status=${completion.data.status} confidence=${completion.data.confidence.toFixed(3)}`,
  );

  console.log('\nJev is working through Vercel AI Gateway.');
}

main().catch((error) => {
  console.error('\nJev test failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
