/**
 * Plugin manifests — `3A-3`. One file per provider, dropped into config/plugins/.
 *
 * No marketplace, no installer, no versioning story. The whole point is the
 * SPEED of adding provider number one through fifty: one manifest file plus one
 * executor binding, minutes not hours.
 *
 * CREDENTIAL VALUES ARE STRUCTURALLY IMPOSSIBLE HERE. `credentialRef` is the
 * NAME of an environment variable, validated to look like one, and the loader
 * never reads its value — only whether it is set, which is what decides
 * `availability`. A manifest is a checked-in file; a secret in one is a secret
 * in git.
 *
 * Zod is the source of truth and the TypeScript type is inferred, so the
 * validator guarding the directory read cannot drift from what the registry
 * codes against.
 */

import { z } from 'zod';
import type { ToolDescriptor } from '@htn/shared';

const dataLabel = z.enum(['public', 'private', 'secret']);
const contextScope = z.enum(['public', 'private', 'local_only']);
const riskClass = z.enum(['auto', 'verify', 'ask_human']);
const transport = z.enum(['native', 'mcp', 'http', 'simulated']);

/**
 * An ENV VAR NAME, not a value. The pattern is what makes a pasted secret fail
 * validation loudly instead of shipping quietly.
 */
const credentialRef = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'credentialRef must be an environment variable NAME, never a value');

export const toolManifestEntrySchema = z.object({
  /** Appended to the plugin's providerId: `browser` + `open` -> `browser.open`. */
  operation: z.string().min(1),
  description: z.string().min(1).max(200),
  /** POINTER to a schema held locally. A path or a registry key, never a schema. */
  schemaRef: z.string().min(1),
  riskClass: riskClass.default('auto'),
  requiredScopes: z.array(z.string()).default([]),
  allowedDataLabels: z.array(dataLabel).default(['public']),
  allowedContextScopes: z.array(contextScope).default(['public']),
  /** A fixture. MUST refuse to execute — see `3A-6`. */
  simulated: z.boolean().default(false),
});

export const pluginManifestSchema = z.object({
  /** Manifest format version, so a loader can reject a future shape. */
  manifestVersion: z.literal(1),
  pluginId: z.string().min(1),
  /** Bumped when a tool's args change. Approvals bind to this. */
  version: z.string().min(1),
  providerId: z.string().min(1),
  family: z.string().min(1),
  displayName: z.string().min(1),
  transport,
  /** For `transport: 'mcp'` or `'http'`. Absent for a native adapter. */
  endpoint: z.string().optional(),
  /** For an MCP server started as a local subprocess. */
  command: z.array(z.string()).optional(),
  /** POINTER into the executor table, e.g. `executor:browser`. */
  executorRef: z.string().min(1),
  credentialRef: credentialRef.optional(),
  tools: z.array(toolManifestEntrySchema).min(1),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export interface ManifestToDescriptorOptions {
  /**
   * Whether the credential this manifest points at is present. The loader
   * supplies this; it decides `availability` and nothing else. The VALUE is
   * never passed in, because nothing here needs it.
   */
  credentialPresent?: boolean;
  /** Force unavailability, e.g. an MCP server that failed to connect. */
  unavailableReason?: 'unauthenticated' | 'unavailable' | 'disabled';
}

/**
 * Manifest -> descriptors.
 *
 * A tool whose credential is missing becomes `unauthenticated`, which the
 * registry filters out before selection — so it can never be chosen, exposed,
 * or executed.
 */
export function manifestToDescriptors(
  manifest: PluginManifest,
  options: ManifestToDescriptorOptions = {},
): ToolDescriptor[] {
  const availability: ToolDescriptor['availability'] = options.unavailableReason
    ? options.unavailableReason
    : manifest.credentialRef && options.credentialPresent === false
      ? 'unauthenticated'
      : 'available';

  return manifest.tools.map((tool) => ({
    id: manifest.providerId + '.' + tool.operation,
    providerId: manifest.providerId,
    family: manifest.family,
    description: tool.description,
    schemaRef: tool.schemaRef,
    transport: tool.simulated ? 'simulated' : manifest.transport,
    riskClass: tool.riskClass,
    requiredScopes: tool.requiredScopes,
    allowedDataLabels: tool.allowedDataLabels,
    allowedContextScopes: tool.allowedContextScopes,
    availability,
    executorRef: manifest.executorRef,
    version: manifest.version,
    simulated: tool.simulated,
    ...(manifest.credentialRef ? { credentialRef: manifest.credentialRef } : {}),
  }));
}

export interface ManifestParseResult {
  manifest?: PluginManifest;
  error?: string;
}

/** Parse one manifest. A bad manifest is skipped, never fatal at startup. */
export function parseManifest(raw: unknown): ManifestParseResult {
  const parsed = pluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.issues
        .map((issue) => issue.path.join('.') + ': ' + issue.message)
        .join('; '),
    };
  }
  return { manifest: parsed.data };
}
