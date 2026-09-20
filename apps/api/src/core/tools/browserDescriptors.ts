import type { DataLabel, Json, ToolDescriptor } from '@htn/shared';
import { BROWSER_EXECUTOR_REF } from './browser.js';
import type { ToolRegistration } from './registry.js';

type BrowserProviderId = 'localbrowser' | 'browserbase';
type BrowserOperation =
  'open' | 'search' | 'extract' | 'inspect' | 'click' | 'type' | 'submit' | 'close';

interface OperationSpec {
  operation: BrowserOperation;
  description: string;
  effect: ToolDescriptor['baselineEffect'];
  reversibility: ToolDescriptor['reversibility'];
  schema: Json;
}

const objectSchema = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const sessionProperty = { type: 'string', minLength: 1 } as const;
const urlProperty = { type: 'string', minLength: 1 } as const;
const textProperty = { type: 'string', minLength: 1 } as const;

const OPERATIONS: readonly OperationSpec[] = [
  {
    operation: 'open',
    description: 'Open a browser session, optionally at a starting URL.',
    effect: 'read',
    reversibility: 'reversible',
    schema: objectSchema({ url: urlProperty }),
  },
  {
    operation: 'search',
    description: 'Search the public web and return a concise result.',
    effect: 'read',
    reversibility: 'reversible',
    schema: objectSchema({ query: textProperty, url: urlProperty }, ['query']),
  },
  {
    operation: 'extract',
    description: 'Extract requested information from a browser page.',
    effect: 'read',
    reversibility: 'reversible',
    schema: objectSchema(
      { sessionId: sessionProperty, url: urlProperty, instruction: textProperty },
      ['instruction'],
    ),
  },
  {
    operation: 'inspect',
    description: 'Inspect the indexed interactive controls on a browser page.',
    effect: 'read',
    reversibility: 'reversible',
    schema: objectSchema({ sessionId: sessionProperty, url: urlProperty }),
  },
  {
    operation: 'click',
    description: 'Click the page control that best matches a specific goal.',
    effect: 'write',
    reversibility: 'recoverable',
    schema: objectSchema({ sessionId: sessionProperty, url: urlProperty, goal: textProperty }, [
      'goal',
    ]),
  },
  {
    operation: 'type',
    description: 'Type an exact value into the page field that best matches a goal.',
    effect: 'write',
    reversibility: 'recoverable',
    schema: objectSchema(
      {
        sessionId: sessionProperty,
        url: urlProperty,
        goal: textProperty,
        text: textProperty,
      },
      ['goal', 'text'],
    ),
  },
  {
    operation: 'submit',
    description: 'Click a submit control; this irreversible action always requires approval.',
    effect: 'write',
    reversibility: 'irreversible',
    schema: objectSchema({ sessionId: sessionProperty, url: urlProperty, goal: textProperty }, [
      'goal',
    ]),
  },
  {
    operation: 'close',
    description: 'Close and release a browser session.',
    effect: 'read',
    reversibility: 'reversible',
    schema: objectSchema({ sessionId: sessionProperty }, ['sessionId']),
  },
];

export interface BrowserDescriptorOptions {
  localAvailable: boolean;
  browserbaseAvailable: boolean;
}

export function browserToolRegistrations(options: BrowserDescriptorOptions): ToolRegistration[] {
  return [
    ...build('localbrowser', ['public', 'private', 'secret', 'local_only'], options.localAvailable),
    ...build('browserbase', ['public', 'private'], options.browserbaseAvailable),
  ];
}

function build(
  providerId: BrowserProviderId,
  allowedDataLabels: DataLabel[],
  available: boolean,
): ToolRegistration[] {
  return OPERATIONS.map((spec) => {
    const id = providerId + '.' + spec.operation;
    return {
      descriptor: {
        id,
        version: '1',
        providerId,
        family: 'browser',
        description: spec.description,
        inputSchemaRef: 'agentos://schemas/' + id + '/1',
        transport: providerId === 'localbrowser' ? 'local' : 'http',
        baselineEffect: spec.effect,
        reversibility: spec.reversibility,
        requiredScopes: [],
        allowedDataLabels,
        availability: available ? 'available' : 'unavailable',
        executorRef: BROWSER_EXECUTOR_REF,
        ...(providerId === 'browserbase' ? { credentialRef: 'BROWSERBASE_API_KEY' } : {}),
      },
      wireName: providerId + '_' + spec.operation,
      inputSchema: spec.schema,
    };
  });
}

export function browserbaseDescriptorsAreSafe(registrations: readonly ToolRegistration[]): boolean {
  return registrations
    .filter((registration) => registration.descriptor.providerId === 'browserbase')
    .every(
      (registration) =>
        !registration.descriptor.allowedDataLabels.includes('secret') &&
        !registration.descriptor.allowedDataLabels.includes('local_only'),
    );
}
