/**
 * The single store instance.
 *
 * TO SWAP IN A REAL DATABASE: write store/sqlite.ts implementing Store, then
 * change the one line below. No service, route, or core file changes.
 */

import { config } from '../config.js';
import { createMemoryStore } from './memory.js';
import { createSqliteStore } from './sqlite.js';

export const store = config.persistToDisk
  ? createSqliteStore(config.sqlitePath)
  : createMemoryStore();

export type { ListRunsFilter, Store } from './types.js';
export { NotFoundError } from './types.js';
