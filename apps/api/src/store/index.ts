/**
 * The single store instance.
 *
 * Graphs and conversations persist to SQLite (store/sqlite.ts) so past tasks
 * survive a restart; everything else stays in memory, optionally snapshotted
 * to JSON when PERSIST_TO_DISK=true -- see sqlite.ts for why the split.
 */

import { config } from '../config.js';
import { createSqliteStore } from './sqlite.js';

export const store = createSqliteStore({ persistRunsToDisk: config.persistToDisk });

export type { ListRunsFilter, Store } from './types.js';
export { NotFoundError } from './types.js';
