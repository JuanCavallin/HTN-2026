import type { ToolDescriptor } from '@htn/shared';

const PUBLIC_AND_PRIVATE = ['public', 'private'] as const;

function tool(
  descriptor: Pick<
    ToolDescriptor,
    'id' | 'family' | 'description' | 'baselineEffect' | 'reversibility' | 'availability'
  > & {
    capabilities: string[];
    aliases: string[];
  },
): ToolDescriptor {
  return {
    version: 'golden-v1',
    providerId: descriptor.family.startsWith('localbrowser')
      ? 'localbrowser'
      : descriptor.family === 'weather'
        ? 'weather'
        : descriptor.family === 'web'
          ? 'openrouter'
          : 'composio',
    inputSchemaRef: `golden://${descriptor.id}`,
    transport: descriptor.family.startsWith('localbrowser') ? 'local' : 'mcp',
    requiredScopes: [],
    allowedDataLabels: [...PUBLIC_AND_PRIVATE],
    executorRef: `golden://${descriptor.id}`,
    ...descriptor,
  };
}

/**
 * Deliberately contains semantically adjacent read/write tools. A selector that relies on
 * provider order or the word "email" alone will fail these fixtures by exposing mail.send for
 * a read task.
 */
export const TOOL_SELECTION_GOLDEN_CATALOG: ToolDescriptor[] = [
  tool({
    id: 'gmail.fetch_emails',
    family: 'gmail',
    description: 'Fetch and list received email messages from Gmail.',
    capabilities: ['email.read', 'email.search'],
    aliases: ['fetch emails', 'received emails', 'inbox', 'recent mail', 'list messages'],
    baselineEffect: 'read',
    reversibility: 'reversible',
    availability: 'available',
  }),
  tool({
    id: 'mail.send',
    family: 'mail',
    description: 'Send an email message to external recipients.',
    capabilities: ['email.send'],
    aliases: ['send email', 'email someone', 'compose mail', 'outbound message'],
    baselineEffect: 'write',
    reversibility: 'irreversible',
    availability: 'available',
  }),
  tool({
    id: 'googlecalendar.create_event',
    family: 'googlecalendar',
    description: 'Create a Google Calendar event and optionally invite attendees.',
    capabilities: ['calendar.create'],
    aliases: ['create event', 'schedule meeting', 'calendar invite', 'book time'],
    baselineEffect: 'write',
    reversibility: 'irreversible',
    availability: 'available',
  }),
  tool({
    id: 'googlecalendar.find_events',
    family: 'googlecalendar',
    description: 'Find and list existing Google Calendar events.',
    capabilities: ['calendar.read'],
    aliases: ['find events', 'read calendar', 'calendar schedule', 'upcoming meetings'],
    baselineEffect: 'read',
    reversibility: 'reversible',
    availability: 'available',
  }),
  tool({
    id: 'localbrowser.open',
    family: 'localbrowser',
    description: 'Open a URL in the local browser.',
    capabilities: ['browser.navigate'],
    aliases: ['open website', 'visit page', 'browse url', 'navigate browser'],
    baselineEffect: 'read',
    reversibility: 'reversible',
    availability: 'available',
  }),
  tool({
    id: 'localbrowser.search',
    family: 'localbrowser',
    description: 'Search the public web in the local browser.',
    capabilities: ['browser.search'],
    aliases: ['web search', 'search browser', 'look up online'],
    baselineEffect: 'read',
    reversibility: 'reversible',
    availability: 'available',
  }),
  tool({
    id: 'weather.forecast',
    family: 'weather',
    description: 'Get structured hourly weather forecasts for a named location and local times.',
    capabilities: ['weather.forecast'],
    aliases: ['weather forecast', 'hourly forecast', 'temperature', 'rain forecast'],
    baselineEffect: 'read',
    reversibility: 'reversible',
    availability: 'available',
  }),
  tool({
    id: 'web.search',
    family: 'web',
    description: 'Search the live public internet and return a grounded answer with source URLs.',
    capabilities: ['web.search'],
    aliases: ['google search', 'internet search', 'search the web', 'look up online'],
    baselineEffect: 'read',
    reversibility: 'reversible',
    availability: 'available',
  }),
  tool({
    id: 'gmail.delete_email',
    family: 'gmail',
    description: 'Permanently delete an email message.',
    capabilities: ['email.delete'],
    aliases: ['delete email', 'remove message permanently'],
    baselineEffect: 'destructive',
    reversibility: 'irreversible',
    availability: 'requires_connection',
  }),
  tool({
    id: 'vendor.unclassified',
    family: 'vendor',
    description: 'An operation whose effect has not been reviewed.',
    capabilities: ['vendor.unknown'],
    aliases: ['unclassified operation'],
    baselineEffect: 'unknown',
    reversibility: 'irreversible',
    availability: 'available',
  }),
];

export interface ToolSelectionGoldenCase {
  name: string;
  task: string;
  requiresExternalTool: boolean;
  expectedSelectedId?: string;
  expectedCapabilities: string[];
  forbiddenIds: string[];
  candidateIds?: string[];
  expectNoCompatibleTool?: boolean;
}

export const TOOL_SELECTION_GOLDEN_CASES: ToolSelectionGoldenCase[] = [
  {
    name: 'typo-heavy recent inbox request',
    task: 'fetch all emails i have recieved in the lasr 24 hours',
    requiresExternalTool: true,
    expectedSelectedId: 'gmail.fetch_emails',
    expectedCapabilities: ['email.read'],
    forbiddenIds: ['mail.send'],
  },
  {
    name: 'email send request',
    task: 'Send an email to Juan with the project update.',
    requiresExternalTool: true,
    expectedSelectedId: 'mail.send',
    expectedCapabilities: ['email.send'],
    forbiddenIds: ['gmail.fetch_emails'],
  },
  {
    name: 'calendar create request',
    task: 'Create a 15 minute calendar invite tomorrow at 2 PM.',
    requiresExternalTool: true,
    expectedSelectedId: 'googlecalendar.create_event',
    expectedCapabilities: ['calendar.create'],
    forbiddenIds: ['googlecalendar.find_events', 'localbrowser.open'],
  },
  {
    name: 'calendar read request',
    task: 'What meetings are on my calendar tomorrow?',
    requiresExternalTool: true,
    expectedSelectedId: 'googlecalendar.find_events',
    expectedCapabilities: ['calendar.read'],
    forbiddenIds: ['googlecalendar.create_event'],
  },
  {
    name: 'structured weather beats browser search',
    task: "search google for today's weather in karachi at 5pm and 10 pm",
    requiresExternalTool: true,
    expectedSelectedId: 'weather.forecast',
    expectedCapabilities: ['weather.forecast'],
    forbiddenIds: ['web.search', 'localbrowser.search', 'localbrowser.open'],
  },
  {
    name: 'grounded internet lookup beats browser scraping',
    task: 'Search Google for the latest OpenAI API news.',
    requiresExternalTool: true,
    expectedSelectedId: 'web.search',
    expectedCapabilities: ['web.search'],
    forbiddenIds: ['localbrowser.search', 'localbrowser.open', 'weather.forecast'],
  },
  {
    name: 'current news implicitly requires grounded search',
    task: "What are today's top AI news stories?",
    requiresExternalTool: true,
    expectedSelectedId: 'web.search',
    expectedCapabilities: ['web.search'],
    forbiddenIds: ['localbrowser.search', 'localbrowser.open', 'weather.forecast'],
  },
  {
    name: 'ordinary text generation needs no tool',
    task: 'Rewrite this sentence to sound friendlier.',
    requiresExternalTool: false,
    expectedCapabilities: [],
    forbiddenIds: TOOL_SELECTION_GOLDEN_CATALOG.map((descriptor) => descriptor.id),
  },
  {
    name: 'explicit browser request',
    task: 'Use the browser to open https://example.com.',
    requiresExternalTool: true,
    expectedSelectedId: 'localbrowser.open',
    expectedCapabilities: ['browser.navigate'],
    forbiddenIds: ['gmail.fetch_emails', 'mail.send'],
  },
  {
    name: 'required capability is unavailable',
    task: 'Permanently delete this email.',
    requiresExternalTool: true,
    expectedCapabilities: ['email.delete'],
    forbiddenIds: ['gmail.delete_email'],
    candidateIds: ['gmail.delete_email'],
    expectNoCompatibleTool: true,
  },
  {
    name: 'available tools have incompatible actions',
    task: 'Fetch the emails I received today.',
    requiresExternalTool: true,
    expectedCapabilities: ['email.read'],
    forbiddenIds: ['mail.send', 'googlecalendar.create_event'],
    candidateIds: ['mail.send', 'googlecalendar.create_event'],
    expectNoCompatibleTool: true,
  },
];

export function candidatesFor(golden: ToolSelectionGoldenCase): ToolDescriptor[] {
  if (!golden.candidateIds) return TOOL_SELECTION_GOLDEN_CATALOG;
  const allowed = new Set(golden.candidateIds);
  return TOOL_SELECTION_GOLDEN_CATALOG.filter((descriptor) => allowed.has(descriptor.id));
}
