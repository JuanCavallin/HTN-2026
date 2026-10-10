/**
 * Capability-aware tool retrieval and bounded Jev selection.
 *
 * Retrieval is deterministic and policy-neutral: it only reduces an already
 * eligible catalog to semantically compatible candidates. Exact-action
 * authorization remains mandatory immediately before execution.
 */

import type {
  DecisionState,
  ProviderCallContext,
  ToolDescriptor,
  ToolEffect,
  ToolboxToolkitDefinition,
} from '@htn/shared';
import type { DecisionService } from '../decisions/service.js';
import { enrichToolDescriptorCapabilities } from './capabilities.js';

const DEFAULT_SHORTLIST_LIMIT = 12;
const DEFAULT_MAX_SELECTED = 8;

export interface ToolIntent {
  requiresTool: boolean;
  requiredCapabilities: string[];
  preferredEffects: ToolEffect[];
  domainHints: string[];
  reasonCodes: string[];
}

export interface RankedToolCandidate {
  descriptor: ToolDescriptor;
  score: number;
  matchedCapabilities: string[];
  lexicalMatches: string[];
}

export interface ToolShortlist {
  intent: ToolIntent;
  candidates: RankedToolCandidate[];
  rejectedIds: string[];
  reasonCodes: string[];
}

export interface ToolSelectionOutcome extends ToolShortlist {
  selected: ToolDescriptor[];
  candidateScores: Record<string, number>;
  confidence: number;
  source: 'jev' | 'deterministic' | 'fallback';
}

export interface SelectToolsForTaskInput {
  /** Original task used only by the local deterministic retriever. */
  task?: string;
  state: DecisionState;
  candidates: ToolDescriptor[];
  decisions: Pick<DecisionService, 'selectTools'>;
  context: ProviderCallContext;
  shortlistLimit?: number;
  maxSelected?: number;
}

/** Infer only high-confidence external capabilities from the task wording. */
export function inferToolIntent(task: string): ToolIntent {
  const normalized = normalizeText(task);
  const tokens = new Set(words(normalized));
  const required = new Set<string>();
  const domains = new Set<string>();
  const effects = new Set<ToolEffect>();
  const reasons: string[] = [];

  const emailDomain = hasAny(tokens, ['email', 'emails', 'gmail', 'inbox', 'mail']);
  if (emailDomain) {
    domains.add('email');
    if (hasAny(tokens, ['delete', 'destroy', 'purge', 'remove'])) {
      required.add('email.delete');
      effects.add('destructive');
    } else if (hasAny(tokens, ['send', 'email', 'forward', 'reply', 'compose'])) {
      // The noun "email" alone must not imply send. Require an outbound verb,
      // or the command form "email <recipient>".
      const outbound =
        hasAny(tokens, ['send', 'forward', 'reply', 'compose']) ||
        /^(?:please\s+)?email\s+\S+/i.test(task.trim());
      if (outbound) {
        required.add('email.send');
        effects.add('write');
      }
    }
    if (
      hasAny(tokens, [
        'fetch',
        'get',
        'read',
        'retrieve',
        'show',
        'check',
        'received',
        'recieved',
        'inbox',
        'recent',
        'latest',
        'last',
        'today',
        'yesterday',
      ])
    ) {
      required.add('email.read');
      effects.add('read');
    }
    if (hasAny(tokens, ['find', 'search', 'list', 'all', 'since', 'before', 'after', 'recent'])) {
      required.add('email.search');
      effects.add('read');
    }
  }

  const calendarDomain = hasAny(tokens, [
    'calendar',
    'calendars',
    'meeting',
    'meetings',
    'event',
    'events',
    'schedule',
    'schedules',
    'agenda',
  ]);
  if (calendarDomain) {
    domains.add('calendar');
    const schedulesSomething =
      tokens.has('schedule') &&
      (tokens.has('meeting') ||
        tokens.has('meetings') ||
        tokens.has('event') ||
        tokens.has('events'));
    if (hasAny(tokens, ['create', 'invite', 'book', 'add']) || schedulesSomething) {
      required.add('calendar.create');
      effects.add('write');
    } else {
      required.add('calendar.read');
      effects.add('read');
    }
  }

  const weatherDomain = hasAny(tokens, [
    'weather',
    'forecast',
    'temperature',
    'temperatures',
    'rain',
    'raining',
    'precipitation',
    'humidity',
  ]);
  if (weatherDomain) {
    domains.add('weather');
    required.add('weather.forecast');
    effects.add('read');
  }

  const searchVerb = hasAny(tokens, ['search', 'find', 'lookup', 'research']);
  const explicitBrowser =
    /https?:\/\//i.test(task) || hasAny(tokens, ['browser', 'browse', 'website', 'webpage']);
  const currentInformation = hasAny(tokens, [
    'news',
    'latest',
    'current',
    'currently',
    'today',
    'tonight',
    'recent',
    'recently',
    'live',
    'breaking',
  ]);
  const publicWebSearch =
    !weatherDomain &&
    !emailDomain &&
    !calendarDomain &&
    !explicitBrowser &&
    (searchVerb || currentInformation);

  if (publicWebSearch && !explicitBrowser) {
    domains.add('web');
    required.add('web.search');
    effects.add('read');
  }

  const browserDomain = explicitBrowser;
  if (browserDomain) {
    domains.add('browser');
    if (searchVerb) {
      required.add('browser.search');
    } else {
      required.add('browser.navigate');
    }
    effects.add('read');
  }

  if (required.size > 0) reasons.push('deterministic-capability-intent');
  else reasons.push('no-required-tool-capability');

  return {
    requiresTool: required.size > 0,
    requiredCapabilities: [...required].sort(),
    preferredEffects: [...effects],
    domainHints: [...domains].sort(),
    reasonCodes: reasons,
  };
}

/**
 * Restrict connected-app discovery before Jev sees toolkit names. This is a
 * recall filter, not a final selection: ambiguous matches still go to Jev.
 */
export function shortlistConnectedToolkits(
  task: string,
  toolkits: ToolboxToolkitDefinition[],
): ToolboxToolkitDefinition[] {
  const intent = inferToolIntent(task);
  const taskText = normalizeText(task);
  const matches = toolkits.filter((toolkit) => {
    const identity = normalizeText(`${toolkit.slug} ${toolkit.name}`);
    if (intent.domainHints.includes('email')) {
      if (/\b(?:gmail|email|mail|outlook)\b/.test(identity)) return true;
    }
    if (intent.domainHints.includes('calendar') && /\bcalendar\b/.test(identity)) return true;
    if (intent.domainHints.includes('browser') && /\b(?:browser|web)\b/.test(identity)) return true;
    if (intent.domainHints.includes('web') && /\b(?:browser|search|web)\b/.test(identity))
      return true;
    return words(identity).some((word) => word.length > 2 && containsWord(taskText, word));
  });
  // A known capability with no matching connected app must not degrade into
  // importing every app. Generic/unknown tasks still preserve recall by
  // letting Jev choose from the connected catalog.
  return matches.length > 0 ? matches : intent.requiresTool ? [] : toolkits;
}

/** Pure deterministic retrieval used by production and the golden suite. */
export function buildToolShortlist(
  task: string,
  descriptors: ToolDescriptor[],
  limit = DEFAULT_SHORTLIST_LIMIT,
): ToolShortlist {
  const enrichedDescriptors = descriptors.map((descriptor) =>
    enrichToolDescriptorCapabilities(descriptor),
  );
  const intent = inferGenericToolIntent(task, inferToolIntent(task), enrichedDescriptors);
  const taskText = normalizeText(task);
  const taskTokens = new Set(words(taskText));
  const rejectedIds: string[] = [];
  const ranked: RankedToolCandidate[] = [];

  for (const descriptor of enrichedDescriptors) {
    if (descriptor.availability !== 'available' || descriptor.baselineEffect === 'unknown') {
      rejectedIds.push(descriptor.id);
      continue;
    }

    const capabilities = descriptor.capabilities ?? [];
    const matchedCapabilities = intent.requiredCapabilities.filter((capability) =>
      capabilities.includes(capability),
    );
    const effectCompatible =
      intent.preferredEffects.length === 0 ||
      intent.preferredEffects.includes(descriptor.baselineEffect);

    // Known external intent is a hard compatibility constraint. A read task
    // can never be rescued by a send-only tool merely because both say email.
    if (intent.requiresTool && (matchedCapabilities.length === 0 || !effectCompatible)) {
      rejectedIds.push(descriptor.id);
      continue;
    }

    const searchable = normalizeText(
      [
        descriptor.id,
        descriptor.family,
        descriptor.description,
        ...(descriptor.aliases ?? []),
      ].join(' '),
    );
    const searchableTokens = new Set(words(searchable));
    const lexicalMatches = [...taskTokens].filter(
      (token) => token.length > 2 && searchableTokens.has(token),
    );
    const phraseMatches = (descriptor.aliases ?? []).filter(
      (alias) => alias.length > 3 && taskText.includes(normalizeText(alias)),
    );
    const domainMatches = intent.domainHints.filter(
      (domain) => searchableTokens.has(domain) || searchable.includes(domain),
    );
    const score =
      matchedCapabilities.length * 100 +
      domainMatches.length * 30 +
      phraseMatches.length * 20 +
      lexicalMatches.length * 3 +
      (effectCompatible ? 5 : 0);

    // No inferred capability means this is an optional-tool task. Only keep a
    // descriptor with actual lexical evidence; ordinary text generation must
    // not acquire tools just because a catalog exists.
    if (!intent.requiresTool && score <= 5) {
      rejectedIds.push(descriptor.id);
      continue;
    }

    ranked.push({
      descriptor,
      score,
      matchedCapabilities,
      lexicalMatches: [...new Set([...lexicalMatches, ...phraseMatches])],
    });
  }

  ranked.sort(
    (left, right) =>
      right.score - left.score || left.descriptor.id.localeCompare(right.descriptor.id),
  );
  const bounded = ranked.slice(0, Math.max(0, limit));
  return {
    intent,
    candidates: bounded,
    rejectedIds: [...new Set(rejectedIds)],
    reasonCodes: [
      ...intent.reasonCodes,
      ...(bounded.length > 0 ? ['deterministic-tool-shortlist'] : ['no-compatible-tool-candidate']),
    ],
  };
}

/** One Jev exact-tool decision, followed by bounded deterministic recovery. */
export async function selectToolsForTask(
  input: SelectToolsForTaskInput,
): Promise<ToolSelectionOutcome> {
  // Deterministic recovery may bypass Jev, but it must never bypass local
  // privacy eligibility. This matters after a raw private tool result tightens
  // a session to local_only: a remote tool that cannot accept that label must
  // disappear instead of being "recovered" back into the model's toolset.
  const policyEligibleCandidates = input.candidates.filter((descriptor) =>
    input.state.dataLabels.every((label) => descriptor.allowedDataLabels.includes(label)),
  );
  const policyRejectedIds = input.candidates
    .filter((descriptor) => !policyEligibleCandidates.includes(descriptor))
    .map((descriptor) => descriptor.id);
  const shortlist = buildToolShortlist(
    input.task ?? input.state.taskSummary,
    policyEligibleCandidates,
    input.shortlistLimit ?? DEFAULT_SHORTLIST_LIMIT,
  );
  const boundedShortlist: ToolShortlist = {
    ...shortlist,
    rejectedIds: [...new Set([...shortlist.rejectedIds, ...policyRejectedIds])],
    reasonCodes: [
      ...shortlist.reasonCodes,
      ...(policyRejectedIds.length > 0 ? ['policy-ineligible-tool-candidate'] : []),
    ],
  };
  const maxSelected = Math.max(
    0,
    Math.min(input.maxSelected ?? DEFAULT_MAX_SELECTED, DEFAULT_MAX_SELECTED),
  );
  if (boundedShortlist.candidates.length === 0 || maxSelected === 0) {
    return {
      ...boundedShortlist,
      selected: [],
      candidateScores: Object.fromEntries(
        boundedShortlist.candidates.map((candidate) => [candidate.descriptor.id, candidate.score]),
      ),
      confidence: boundedShortlist.intent.requiresTool ? 0 : 1,
      source: 'deterministic',
    };
  }

  const candidates = boundedShortlist.candidates.map((candidate) => candidate.descriptor);
  const decision = await input.decisions.selectTools(input.state, candidates, input.context);
  const allowed = new Set(candidates.map((descriptor) => descriptor.id));
  let selectedIds = decision.selectedToolIds.filter((id) => allowed.has(id)).slice(0, maxSelected);
  const reasons = [...boundedShortlist.reasonCodes, ...decision.reasonCodes];
  let source: ToolSelectionOutcome['source'] = 'jev';

  if (selectedIds.length === 0 && boundedShortlist.intent.requiresTool) {
    selectedIds = [boundedShortlist.candidates[0]!.descriptor.id];
    reasons.push('deterministic-compatible-tool-recovery-fallback');
    source = 'fallback';
  }

  const selected = candidates.filter((descriptor) => selectedIds.includes(descriptor.id));
  const candidateScores = Object.fromEntries(
    boundedShortlist.candidates.map((candidate) => [
      candidate.descriptor.id,
      decision.confidences[candidate.descriptor.id] ?? normalizeScore(candidate.score),
    ]),
  );
  const selectedScores = selected.map((descriptor) => candidateScores[descriptor.id] ?? 0);

  return {
    ...boundedShortlist,
    reasonCodes: [...new Set(reasons)],
    selected,
    candidateScores,
    confidence:
      selectedScores.length > 0
        ? selectedScores.reduce((sum, value) => sum + value, 0) / selectedScores.length
        : 1,
    source,
  };
}

function normalizeScore(score: number): number {
  return Math.max(0, Math.min(1, score / 200));
}

function inferGenericToolIntent(
  task: string,
  base: ToolIntent,
  descriptors: ToolDescriptor[],
): ToolIntent {
  if (base.requiresTool) return base;
  const taskText = normalizeText(task);
  const tokens = new Set(words(taskText));
  const effect: ToolEffect | undefined = hasAny(tokens, ['delete', 'remove', 'purge', 'revoke'])
    ? 'destructive'
    : hasAny(tokens, [
          'create',
          'update',
          'add',
          'append',
          'post',
          'publish',
          'send',
          'upload',
          'move',
        ])
      ? 'write'
      : hasAny(tokens, [
            'fetch',
            'get',
            'read',
            'list',
            'search',
            'find',
            'show',
            'check',
            'retrieve',
            'view',
          ])
        ? 'read'
        : undefined;
  if (!effect) return base;

  const matchingFamilies = new Set(
    descriptors.flatMap((descriptor) => {
      const family = normalizeText(descriptor.family);
      const provider = normalizeText(descriptor.providerId);
      return containsWord(taskText, family) || containsWord(taskText, provider) ? [family] : [];
    }),
  );
  if (matchingFamilies.size === 0) return base;

  const requiredCapabilities = [
    ...new Set(
      descriptors.flatMap((descriptor) => {
        const family = normalizeText(descriptor.family);
        if (!matchingFamilies.has(family) || descriptor.baselineEffect !== effect) return [];
        return (descriptor.capabilities ?? []).filter(
          (capability) => capability === `${family}.${effect}`,
        );
      }),
    ),
  ];
  if (requiredCapabilities.length === 0) return base;

  return {
    requiresTool: true,
    requiredCapabilities,
    preferredEffects: [effect],
    domainHints: [...matchingFamilies].sort(),
    reasonCodes: ['deterministic-generic-tool-intent'],
  };
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9:/._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(value: string): string[] {
  return value.match(/[a-z0-9]+/g) ?? [];
}

function hasAny(tokens: Set<string>, values: string[]): boolean {
  return values.some((value) => tokens.has(value));
}

function containsWord(value: string, word: string): boolean {
  return ` ${value} `.includes(` ${word} `);
}
