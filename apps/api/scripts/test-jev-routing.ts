import type { IntelligenceLevel, PrivacyRoute, ProviderCallContext } from '@htn/shared';
import { config } from '../src/config.js';
import { createLiveJev } from '../src/providers/jev/live.js';

type PrivacySetting = 'auto' | PrivacyRoute;
type IntelligenceSetting = 'auto' | IntelligenceLevel;

interface Scenario {
  name: string;
  task: string;
  privacy: PrivacySetting;
  intelligence: IntelligenceSetting;
  expectedPrivacy?: PrivacyRoute;
  expectedIntelligence?: IntelligenceLevel;
}

const MODEL_LABELS = {
  private_low: 'small private local model',
  private_high: 'strong private local model',
  cloud_low: 'small inexpensive cloud model',
  cloud_high: 'strong expensive frontier model',
} as const;

const DEFAULT_SCENARIOS: Scenario[] = [
  {
    name: 'Private, low intelligence',
    task: 'Read my resume and extract my name, skills, and years of experience.',
    privacy: 'auto',
    intelligence: 'auto',
    expectedPrivacy: 'private',
    expectedIntelligence: 'low',
  },
  {
    name: 'Private, high intelligence',
    task: 'Analyze confidential merger documents and develop a nuanced negotiation strategy.',
    privacy: 'auto',
    intelligence: 'auto',
    expectedPrivacy: 'private',
    expectedIntelligence: 'high',
  },
  {
    name: 'Cloud, low intelligence',
    task: 'Search current open software engineering jobs at Google using public careers pages.',
    privacy: 'auto',
    intelligence: 'auto',
    expectedPrivacy: 'cloud',
    expectedIntelligence: 'low',
  },
  {
    name: 'Cloud, high intelligence',
    task: 'Design and critically evaluate a zero-downtime migration strategy for a public reference architecture with conflicting consistency and latency requirements.',
    privacy: 'auto',
    intelligence: 'auto',
    expectedPrivacy: 'cloud',
    expectedIntelligence: 'high',
  },
];

const ctx: ProviderCallContext = {
  runId: 'jev_routing_test',
  stepId: 'jev_routing_test_step',
  policyRule: 'synthetic-sanitized-routing-test',
};

function usage(): string {
  return `Usage:
  pnpm test:jev:routing
  pnpm test:jev:routing -- "Read my resume and summarize my experience"
  pnpm test:jev:routing -- "Search current software jobs at Google"

Options:
  --privacy auto|private|cloud       Optional override; defaults to auto
  --intelligence auto|low|high       Optional override; defaults to auto
  --strict                           Fail when built-in expected choices differ
  --help                             Show this help

In auto mode Jev independently chooses privacy and intelligence. Never paste actual
resume contents, secrets, or personal data here; send only a sanitized task description.`;
}

function parsePrivacy(value: string | undefined): PrivacySetting {
  if (value === 'auto' || value === 'private' || value === 'cloud') return value;
  throw new Error('--privacy must be auto, private, or cloud.');
}

function parseIntelligence(value: string | undefined): IntelligenceSetting {
  if (value === 'auto' || value === 'low' || value === 'high') return value;
  throw new Error('--intelligence must be auto, low, or high.');
}

function parseArgs(args: string[]): { scenarios: Scenario[]; strict: boolean } {
  if (args.includes('--help')) {
    console.log(usage());
    process.exit(0);
  }

  let privacy: PrivacySetting = 'auto';
  let intelligence: IntelligenceSetting = 'auto';
  let strict = false;
  const promptParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--privacy') {
      privacy = parsePrivacy(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--privacy=')) {
      privacy = parsePrivacy(arg.slice('--privacy='.length));
      continue;
    }
    if (arg === '--intelligence') {
      intelligence = parseIntelligence(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--intelligence=')) {
      intelligence = parseIntelligence(arg.slice('--intelligence='.length));
      continue;
    }
    promptParts.push(arg);
  }

  if (promptParts.length === 0) return { scenarios: DEFAULT_SCENARIOS, strict };

  return {
    scenarios: [
      {
        name: 'Custom task',
        task: promptParts.join(' '),
        privacy,
        intelligence,
      },
    ],
    strict,
  };
}

function modelLabel(privacy: PrivacyRoute, intelligence: IntelligenceLevel): string {
  return MODEL_LABELS[`${privacy}_${intelligence}`];
}

async function main(): Promise<void> {
  const { scenarios, strict } = parseArgs(process.argv.slice(2));
  const providerConfig = config.providers.jev;

  if (providerConfig.mode !== 'live') {
    throw new Error('Jev is not live. Set JEV_MODE=live in the root .env file.');
  }
  if (!providerConfig.apiKey) {
    throw new Error('Set AI_GATEWAY_API_KEY in the ignored root .env file.');
  }

  const jev = createLiveJev(providerConfig);
  let mismatches = 0;

  for (const [index, scenario] of scenarios.entries()) {
    console.log(`\n${index + 1}. ${scenario.name}`);
    console.log(`   Task: ${scenario.task}`);

    const context = [
      scenario.privacy === 'auto'
        ? 'privacy_mode=auto. Infer private or cloud from the task description.'
        : `privacy_override=${scenario.privacy}.`,
      scenario.intelligence === 'auto'
        ? 'intelligence_mode=auto. Infer low or high from task complexity.'
        : `intelligence_override=${scenario.intelligence}.`,
    ].join(' ');

    const result = await jev.route({ task: scenario.task, availableTools: [], context }, ctx);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);

    const effectivePrivacy = scenario.privacy === 'auto' ? result.data.privacy : scenario.privacy;
    const effectiveIntelligence =
      scenario.intelligence === 'auto' ? result.data.intelligence : scenario.intelligence;

    console.log(
      `   Privacy: ${result.data.privacy} (confidence ${result.data.privacyConfidence.toFixed(3)})`,
    );
    console.log(
      `   Intelligence: ${result.data.intelligence} (confidence ${result.data.intelligenceConfidence.toFixed(3)})`,
    );
    console.log(`   Effective model: ${modelLabel(effectivePrivacy, effectiveIntelligence)}`);

    const privacyMatches =
      !scenario.expectedPrivacy || effectivePrivacy === scenario.expectedPrivacy;
    const intelligenceMatches =
      !scenario.expectedIntelligence || effectiveIntelligence === scenario.expectedIntelligence;
    if (scenario.expectedPrivacy || scenario.expectedIntelligence) {
      console.log(
        `   Expected: privacy=${scenario.expectedPrivacy ?? 'any'}, ` +
          `intelligence=${scenario.expectedIntelligence ?? 'any'} — ` +
          `${privacyMatches && intelligenceMatches ? 'MATCH' : 'MISMATCH'}`,
      );
    }
    if (!privacyMatches || !intelligenceMatches) mismatches += 1;
  }

  console.log(`\nCompleted ${scenarios.length} live Jev routing evaluation(s).`);
  if (strict && mismatches > 0) {
    throw new Error(`${mismatches} expected routing decision(s) did not match.`);
  }
}

main().catch((error) => {
  console.error('\nJev routing test failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
