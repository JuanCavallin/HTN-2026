/**
 * Deterministic semantic metadata for tool retrieval.
 *
 * Capabilities and aliases help a selector find a small relevant candidate
 * set. They are never authorization inputs: baseline effect, reversibility,
 * scopes, and the exact-action gate remain the security boundary.
 */

import type { ToolDescriptor } from '@htn/shared';

export interface ToolCapabilityInferenceInput {
  id: string;
  family: string;
  providerId?: string;
  toolkit?: string;
  baselineEffect: ToolDescriptor['baselineEffect'];
  description?: string;
}

export interface ToolCapabilityInferenceContext {
  /** Provider-native toolkit name when it is more specific than `family`. */
  toolkit?: string;
}

const REVIEWED_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  'mail.send': ['email.send'],
  'gmail.send_email': ['email.send'],
  'gmail.fetch_emails': ['email.read', 'email.search'],
  'gmail.fetch_email': ['email.read'],
  'gmail.get_email': ['email.read'],
  'gmail.get_message': ['email.read'],
  'gmail.get_thread': ['email.read'],
  'gmail.read_email': ['email.read'],
  'gmail.search_emails': ['email.search'],
  'gmail.search_messages': ['email.search'],
  'gmail.list_emails': ['email.search'],
  'gmail.list_messages': ['email.search'],
  'googlecalendar.create_event': ['calendar.create'],
  'googlecalendar.quick_add': ['calendar.create'],
  'googlecalendar.get_event': ['calendar.read'],
  'googlecalendar.list_events': ['calendar.read'],
  'googlecalendar.search_events': ['calendar.read'],
  'googlecalendar.find_event': ['calendar.read'],
  'weather.forecast': ['weather.forecast'],
  'web.search': ['web.search'],
};

const ALIASES_BY_CAPABILITY: Readonly<Record<string, readonly string[]>> = {
  'email.read': ['email', 'gmail', 'inbox', 'read email', 'email message'],
  'email.search': ['email', 'gmail', 'inbox search', 'find email', 'search email'],
  'email.send': ['email', 'gmail', 'send email', 'compose email', 'outbound message'],
  'calendar.read': [
    'calendar',
    'google calendar',
    'calendar events',
    'find event',
    'view schedule',
  ],
  'calendar.create': [
    'calendar',
    'google calendar',
    'create event',
    'schedule meeting',
    'calendar invite',
  ],
  'browser.navigate': ['browser', 'open page', 'visit website', 'navigate web'],
  'browser.search': ['browser', 'web search', 'search web', 'internet search'],
  'weather.forecast': [
    'weather',
    'weather forecast',
    'hourly forecast',
    'temperature',
    'rain forecast',
  ],
  'web.search': ['google search', 'internet search', 'search the web', 'look up online'],
};

const EMAIL_DOMAINS = new Set(['email', 'gmail', 'mail']);
const CALENDAR_DOMAINS = new Set(['calendar', 'googlecalendar']);
const BROWSER_DOMAINS = new Set(['browser', 'localbrowser', 'browserbase', 'web']);
const WEATHER_DOMAINS = new Set(['weather', 'forecast']);

const SEARCH_ACTIONS = new Set(['find', 'list', 'query', 'search']);
const READ_ACTIONS = new Set(['fetch', 'get', 'read', 'retrieve', 'view']);
const SEND_ACTIONS = new Set(['compose', 'forward', 'reply', 'send']);
const CREATE_ACTIONS = new Set(['add', 'create', 'invite', 'quick', 'schedule']);
const NAVIGATE_ACTIONS = new Set(['goto', 'navigate', 'open', 'visit']);

/** Infer stable capability tokens without mutating or trusting model output. */
export function inferToolCapabilities(input: ToolCapabilityInferenceInput): string[] {
  const id = input.id.trim().toLowerCase();
  const reviewed = REVIEWED_CAPABILITIES[id];
  if (reviewed) return [...reviewed];

  const identityTokens = tokenSet(
    [input.id, input.family, input.providerId, input.toolkit].filter(Boolean).join(' '),
  );
  const descriptionTokens = tokenSet(input.description ?? '');
  const allTokens = union(identityTokens, descriptionTokens);
  const capabilities = new Set<string>();

  const family = normalizeId(input.toolkit || input.family);
  if (family && input.baselineEffect !== 'unknown') {
    capabilities.add(`${family}.${input.baselineEffect}`);
  }

  if (intersects(identityTokens, EMAIL_DOMAINS)) {
    inferEmailCapabilities(input.baselineEffect, allTokens, capabilities);
  }
  if (intersects(identityTokens, CALENDAR_DOMAINS)) {
    inferCalendarCapabilities(input.baselineEffect, allTokens, capabilities);
  }
  if (intersects(identityTokens, BROWSER_DOMAINS)) {
    inferBrowserCapabilities(input.baselineEffect, allTokens, capabilities);
  }
  if (intersects(identityTokens, WEATHER_DOMAINS) && input.baselineEffect === 'read') {
    capabilities.add('weather.forecast');
  }

  return [...capabilities].sort();
}

/** Natural retrieval terms derived only from normalized semantic capabilities. */
export function inferToolAliases(input: ToolCapabilityInferenceInput): string[] {
  return aliasesForCapabilities(inferToolCapabilities(input));
}

/**
 * Return a new descriptor with normalized, deduplicated semantic metadata.
 * Existing reviewed metadata is preserved; deterministic inference fills gaps.
 */
export function enrichToolDescriptorCapabilities(
  descriptor: ToolDescriptor,
  context: ToolCapabilityInferenceContext = {},
): ToolDescriptor {
  const input: ToolCapabilityInferenceInput = {
    id: descriptor.id,
    family: descriptor.family,
    providerId: descriptor.providerId,
    toolkit: context.toolkit,
    baselineEffect: descriptor.baselineEffect,
    description: descriptor.description,
  };
  const capabilities = normalizedCapabilities([
    ...(descriptor.capabilities ?? []),
    ...inferToolCapabilities(input),
  ]);
  const aliases = normalizedAliases([
    ...(descriptor.aliases ?? []),
    ...aliasesForCapabilities(capabilities),
  ]);

  return {
    ...descriptor,
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}

function inferEmailCapabilities(
  effect: ToolDescriptor['baselineEffect'],
  tokens: Set<string>,
  capabilities: Set<string>,
): void {
  if (effect === 'destructive' && tokens.has('delete')) capabilities.add('email.delete');
  if (effect === 'read') {
    if (intersects(tokens, SEARCH_ACTIONS)) capabilities.add('email.search');
    if (intersects(tokens, READ_ACTIONS)) capabilities.add('email.read');
  }
  if (effect === 'write' && intersects(tokens, SEND_ACTIONS)) capabilities.add('email.send');
}

function inferCalendarCapabilities(
  effect: ToolDescriptor['baselineEffect'],
  tokens: Set<string>,
  capabilities: Set<string>,
): void {
  if (
    effect === 'read' &&
    (intersects(tokens, SEARCH_ACTIONS) || intersects(tokens, READ_ACTIONS))
  ) {
    capabilities.add('calendar.read');
  }
  if (effect === 'write' && intersects(tokens, CREATE_ACTIONS)) {
    capabilities.add('calendar.create');
  }
}

function inferBrowserCapabilities(
  effect: ToolDescriptor['baselineEffect'],
  tokens: Set<string>,
  capabilities: Set<string>,
): void {
  if (effect !== 'read') return;
  if (intersects(tokens, SEARCH_ACTIONS)) capabilities.add('browser.search');
  if (intersects(tokens, NAVIGATE_ACTIONS)) capabilities.add('browser.navigate');
}

function aliasesForCapabilities(capabilities: string[]): string[] {
  return normalizedAliases(
    capabilities.flatMap((capability) => {
      const reviewed = ALIASES_BY_CAPABILITY[capability];
      if (reviewed) return reviewed;
      const words = capability.replace(/[._-]+/g, ' ');
      const family = words.split(' ')[0];
      return family ? [family, words] : [words];
    }),
  );
}

function normalizedCapabilities(values: string[]): string[] {
  return [
    ...new Set(
      values.map(normalizeId).filter((value) => /^[a-z0-9]+(?:\.[a-z0-9]+)*$/.test(value)),
    ),
  ].sort();
}

function normalizedAliases(values: string[]): string[] {
  return [
    ...new Set(
      values.map((value) => value.toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean),
    ),
  ].sort();
}

function normalizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

function tokenSet(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function union(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left, ...right]);
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of right) {
    if (left.has(value)) return true;
  }
  return false;
}
