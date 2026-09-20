/**
 * Reads config/plugins/ at startup and registers whatever it finds — `3A-3`.
 *
 * Deliberately boring and deliberately forgiving: a malformed manifest is
 * logged and SKIPPED, never fatal. A hackathon repo that will not boot because
 * someone fat-fingered a JSON comma is worse than one tool being missing, and
 * the registry works correctly with zero descriptors anyway.
 *
 * This is the one file under core/tools/ that touches the filesystem. It is a
 * startup loader, it reads a directory of checked-in config and nothing else,
 * and it takes the directory as an argument rather than knowing where it is.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDescriptor } from '@htn/shared';
import { manifestToDescriptors, parseManifest } from './manifest.js';

export interface LoadedPlugins {
  descriptors: ToolDescriptor[];
  loaded: string[];
  skipped: { file: string; reason: string }[];
}

/**
 * `credentialPresent` is answered by looking up the env var NAME and checking
 * only that it is non-empty. The value is never read, logged, or returned.
 */
function credentialPresent(ref: string | undefined): boolean {
  if (!ref) return true;
  const value = process.env[ref];
  return typeof value === 'string' && value.trim().length > 0;
}

export async function loadPluginManifests(directory: string): Promise<LoadedPlugins> {
  const result: LoadedPlugins = { descriptors: [], loaded: [], skipped: [] };

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    // No config/plugins/ at all is a normal state while the catalog is empty.
    return result;
  }

  for (const entry of entries.filter((f) => f.endsWith('.json')).sort()) {
    const file = join(directory, entry);
    try {
      const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
      const { manifest, error } = parseManifest(raw);
      if (!manifest) {
        result.skipped.push({ file: entry, reason: error ?? 'invalid manifest' });
        continue;
      }
      result.descriptors.push(
        ...manifestToDescriptors(manifest, {
          credentialPresent: credentialPresent(manifest.credentialRef),
        }),
      );
      result.loaded.push(entry);
    } catch (err) {
      result.skipped.push({
        file: entry,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
