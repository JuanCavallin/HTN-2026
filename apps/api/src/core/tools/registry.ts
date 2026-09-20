import { isDeepStrictEqual } from 'node:util';
import Ajv, { type AnySchema } from 'ajv';
import type { Json, ToolDescriptor } from '@htn/shared';

/** Full schemas remain server-side; Jev receives only ToolDescriptor metadata. */
export interface RegisteredTool {
  descriptor: ToolDescriptor;
  /** Stable MCP-facing name; never accepted from a model without this trusted mapping. */
  wireName: string;
  inputSchema: Json;
  /** OAuth/provider scopes confirmed by the adapter; never inferred from a model call. */
  grantedScopes: string[];
}

export interface ToolRegistration {
  descriptor: ToolDescriptor;
  /** Conservative OpenAI/MCP-compatible name. Defaults from the stable AgentOS ID. */
  wireName?: string;
  inputSchema: Json;
  grantedScopes?: string[];
}

export interface ToolRegistry {
  get(toolId: string): Promise<RegisteredTool | null>;
  getByWireName(wireName: string): Promise<RegisteredTool | null>;
  list(): Promise<RegisteredTool[]>;
  resolve(toolIds: string[]): Promise<ToolDescriptor[]>;
}

/**
 * Trusted, provider-neutral tool metadata. Provider adapters translate vendor
 * names into AgentOS IDs before registering; credentials never enter here.
 */
export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly toolIdsByWireName = new Map<string, string>();

  register(registration: ToolRegistration): void {
    validateRegistration(registration);
    validateJsonSchema(registration);
    const wireName = registration.wireName ?? defaultWireName(registration.descriptor.id);
    validateWireName(wireName, registration.descriptor.id);
    const existingWireOwner = this.toolIdsByWireName.get(wireName);
    if (existingWireOwner && existingWireOwner !== registration.descriptor.id) {
      throw new Error(
        'Tool wire name is already registered: ' + wireName + ' (' + existingWireOwner + ')',
      );
    }
    const existing = this.tools.get(registration.descriptor.id);
    if (existing?.descriptor.version === registration.descriptor.version) {
      assertVersionIsImmutable(existing, { ...registration, wireName });
    }
    const grantedScopes = [...new Set(registration.grantedScopes ?? [])];
    if (existing && existing.wireName !== wireName) {
      this.toolIdsByWireName.delete(existing.wireName);
    }
    this.tools.set(
      registration.descriptor.id,
      Object.freeze(cloneRegistration({ ...registration, wireName, grantedScopes })),
    );
    this.toolIdsByWireName.set(wireName, registration.descriptor.id);
  }

  registerMany(registrations: ToolRegistration[]): void {
    for (const registration of registrations) this.register(registration);
  }

  unregister(toolId: string): boolean {
    const existing = this.tools.get(toolId);
    if (!existing) return false;
    this.toolIdsByWireName.delete(existing.wireName);
    return this.tools.delete(toolId);
  }

  async get(toolId: string): Promise<RegisteredTool | null> {
    const tool = this.tools.get(toolId);
    return tool ? cloneRegistration(tool) : null;
  }

  async getByWireName(wireName: string): Promise<RegisteredTool | null> {
    const toolId = this.toolIdsByWireName.get(wireName);
    return toolId ? this.get(toolId) : null;
  }

  async list(): Promise<RegisteredTool[]> {
    return [...this.tools.values()]
      .sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id))
      .map((registered) => withEffectiveAvailability(cloneRegistration(registered)));
  }

  async resolve(toolIds: string[]): Promise<ToolDescriptor[]> {
    const seen = new Set<string>();
    return toolIds.flatMap((id) => {
      if (seen.has(id)) return [];
      seen.add(id);
      const registered = this.tools.get(id);
      return registered
        ? [{ ...withEffectiveAvailability(cloneRegistration(registered)).descriptor }]
        : [];
    });
  }
}

function validateJsonSchema(registration: ToolRegistration): void {
  try {
    new Ajv({ allErrors: true, strict: true }).compile(
      structuredClone(registration.inputSchema) as AnySchema,
    );
  } catch (error) {
    throw new Error(
      'Invalid JSON Schema for ' +
        registration.descriptor.id +
        ': ' +
        (error instanceof Error ? error.message : 'unknown schema error'),
    );
  }
}

function assertVersionIsImmutable(
  existing: RegisteredTool,
  registration: ToolRegistration & { wireName: string },
): void {
  const { availability: _existingAvailability, ...existingDescriptor } = existing.descriptor;
  const { availability: _nextAvailability, ...nextDescriptor } = registration.descriptor;
  if (
    existing.wireName !== registration.wireName ||
    !isDeepStrictEqual(existingDescriptor, nextDescriptor) ||
    !isDeepStrictEqual(existing.inputSchema, registration.inputSchema)
  ) {
    throw new Error(
      'Tool descriptor/schema changed without a version bump: ' + registration.descriptor.id,
    );
  }
}

function withEffectiveAvailability(registration: RegisteredTool): RegisteredTool {
  const missingScope = registration.descriptor.requiredScopes.some(
    (scope) => !registration.grantedScopes.includes(scope),
  );
  if (registration.descriptor.availability !== 'available' || !missingScope) {
    return registration;
  }
  return {
    ...registration,
    descriptor: { ...registration.descriptor, availability: 'requires_connection' },
  };
}

function validateRegistration(registration: ToolRegistration): void {
  const { descriptor, inputSchema } = registration;
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(descriptor.id)) {
    throw new Error('Tool IDs must be stable lowercase names: ' + descriptor.id);
  }
  if (!descriptor.version.trim()) throw new Error('Tool descriptor version is required.');
  if (!descriptor.executorRef.trim()) throw new Error('Tool executorRef is required.');
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    throw new Error('Tool inputSchema must be a JSON object: ' + descriptor.id);
  }
}

function validateWireName(wireName: string, toolId: string): void {
  // Hermes prefixes this with `mcp__agentos__`; 48 keeps the final OpenAI function
  // name below the common 64-character provider limit.
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(wireName)) {
    throw new Error('Tool wireName must be 1-48 compatible characters: ' + toolId);
  }
}

function defaultWireName(toolId: string): string {
  const normalized = toolId.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized.length <= 48) return normalized;
  throw new Error('Long tool IDs require an explicit wireName: ' + toolId);
}

function cloneRegistration(registration: RegisteredTool): RegisteredTool {
  return {
    descriptor: {
      ...registration.descriptor,
      requiredScopes: [...registration.descriptor.requiredScopes],
      allowedDataLabels: [...registration.descriptor.allowedDataLabels],
    },
    wireName: registration.wireName,
    inputSchema: structuredClone(registration.inputSchema),
    grantedScopes: [...registration.grantedScopes],
  };
}
