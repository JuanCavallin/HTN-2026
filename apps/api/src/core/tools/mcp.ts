/**
 * The MCP client seam — `3A-2`.
 *
 * ============================================================================
 * BLOCKED ON A DEPENDENCY DECISION, AND DELIBERATELY NOT FAKED.
 *
 * There is no MCP client in this repo, and `docs/person-3.md` `3A-2` says to
 * confirm with Person 4 — who owns root tooling and dependency additions —
 * before adding one. So this file defines the BOUNDARY and loads
 * `@modelcontextprotocol/sdk` dynamically if it is ever installed. With no
 * package present, `connect()` reports `unavailable` and the registry excludes
 * that server from selection, which is the correct fail-closed behaviour and is
 * exactly what an unreachable server should do anyway.
 *
 * To unblock:  pnpm --filter @htn/api add @modelcontextprotocol/sdk
 * Nothing in this file's interface changes when that happens.
 *
 * DO NOT PICK SERVERS YET. Which MCP servers matter is decided at the hackathon
 * with the sponsor list. You configure existing servers here; you do not write
 * them.
 *
 * TOOL DESCRIPTIONS AND OUTPUTS FROM AN MCP SERVER ARE UNTRUSTED. A server
 * describing a tool as "safe, no approval needed" changes nothing: risk class
 * comes from OUR manifest and OUR policy, never from the server's own words.
 * `discover()` below therefore takes risk and label defaults from the manifest
 * and ignores anything the server says about permissions.
 * ============================================================================
 */

import type { ToolDescriptor } from '@htn/shared';
import type { PluginManifest } from './manifest.js';
import { manifestToDescriptors } from './manifest.js';

const MCP_SPECIFIER = '@modelcontextprotocol/sdk/client/index.js';

export interface McpDiscovery {
  availability: ToolDescriptor['availability'];
  descriptors: ToolDescriptor[];
  /** Why, when availability is not `available`. Shown in provider health. */
  detail?: string;
}

export interface McpClient {
  /**
   * Connect to the server a manifest describes and return descriptors for
   * whatever it exposes. Never throws: an unreachable server is a normal state
   * and must produce `unavailable`, not a crashed startup.
   */
  discover(manifest: PluginManifest): Promise<McpDiscovery>;
  readonly installed: boolean;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

let sdkPromise: Promise<unknown> | undefined;

function loadSdk(): Promise<unknown> {
  sdkPromise ??= import(MCP_SPECIFIER).catch(() => null);
  return sdkPromise;
}

export function createMcpClient(): McpClient {
  let installed = false;

  return {
    get installed() {
      return installed;
    },

    async discover(manifest: PluginManifest): Promise<McpDiscovery> {
      if (manifest.transport !== 'mcp') {
        return {
          availability: 'available',
          descriptors: manifestToDescriptors(manifest),
        };
      }

      const sdk = await loadSdk();
      installed = sdk !== null;

      if (!sdk) {
        return {
          availability: 'unavailable',
          descriptors: manifestToDescriptors(manifest, { unavailableReason: 'unavailable' }),
          detail:
            'No MCP client installed. Add ' +
            MCP_SPECIFIER.split('/').slice(0, 2).join('/') +
            ' (dependency owner: Person 4) to enable MCP servers.',
        };
      }

      // The credential is checked by NAME only — whether it is set, never what
      // it contains. An unauthenticated server is excluded from selection
      // rather than attempted and failed at execution time.
      const credentialSet =
        !manifest.credentialRef || (process.env[manifest.credentialRef] ?? '').trim().length > 0;

      if (!credentialSet) {
        return {
          availability: 'unauthenticated',
          descriptors: manifestToDescriptors(manifest, { unavailableReason: 'unauthenticated' }),
          detail: manifest.credentialRef + ' is not set.',
        };
      }

      // The live connect + listTools call goes here once the dependency lands.
      // It is left unimplemented rather than guessed: invented code that
      // compiles and looks finished is worse than a boundary that says what to
      // ask for. `discoverToDescriptors` below is the shape it must produce.
      return {
        availability: 'unavailable',
        descriptors: manifestToDescriptors(manifest, { unavailableReason: 'unavailable' }),
        detail: 'MCP client is installed but connect() is not wired yet (3A-2).',
      };
    },
  };
}

/**
 * Map what a server reports onto our descriptors.
 *
 * Note what is taken from the SERVER (names, descriptions, schemas) and what is
 * taken from OUR MANIFEST (risk class, data labels, context scopes, executor,
 * credential). That split is the whole untrusted-description rule: a server
 * can tell us what its tools are called, never what they are allowed to do.
 */
export function discoverToDescriptors(
  manifest: PluginManifest,
  tools: readonly McpToolInfo[],
): ToolDescriptor[] {
  const fallback = manifest.tools[0];
  return tools.map((tool) => ({
    id: manifest.providerId + '.' + tool.name,
    providerId: manifest.providerId,
    family: manifest.family,
    // Truncated: a description is routing metadata that reaches Jev, and a
    // server that returns a 4KB description should not become a 4KB request.
    description: (tool.description ?? tool.name).slice(0, 200),
    schemaRef: 'mcp:' + manifest.pluginId + '/' + tool.name,
    transport: 'mcp',
    riskClass: fallback?.riskClass ?? 'ask_human',
    requiredScopes: fallback?.requiredScopes ?? [],
    allowedDataLabels: fallback?.allowedDataLabels ?? ['public'],
    allowedContextScopes: fallback?.allowedContextScopes ?? ['public'],
    availability: 'available',
    executorRef: manifest.executorRef,
    version: manifest.version,
    simulated: false,
    ...(manifest.credentialRef ? { credentialRef: manifest.credentialRef } : {}),
  }));
}
