/**
 * SQLite-backed persistence for graphs and conversations -- the two documents
 * a "task" is made of (see types.ts: both are mutable and not scoped to a run).
 *
 * Everything else (runs, steps, approvals, egress, PII spans, schedule
 * decisions, the event log) stays on the in-memory Store: it is per-run
 * scratch data written on the interpreter's hot path, a run already snapshots
 * the graph it executed, and PERSIST_TO_DISK's JSON snapshot covers it if a
 * restart needs to survive. Putting THAT in SQLite too is the upgrade
 * memory.ts's own comment describes -- do it when a concrete need shows up,
 * not preemptively.
 *
 * Uses node's built-in `node:sqlite` (stable since Node 22.5, no native
 * addon) instead of better-sqlite3, so there is nothing to compile -- and
 * nothing new in package.json.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentGraph, Conversation } from '@htn/shared';
import { createMemoryStore } from './memory.js';
import type { Store } from './types.js';

const DB_PATH = resolve(process.cwd(), '../../.data/graphs.db');

interface Row {
  data: string;
}

export function createSqliteStore(opts: { persistRunsToDisk?: boolean } = {}): Store & {
  hydrate(): Promise<void>;
} {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS graphs (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const upsertGraph = db.prepare(
    'INSERT INTO graphs (id, data, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  );
  const selectGraph = db.prepare('SELECT data FROM graphs WHERE id = ?');
  const selectAllGraphs = db.prepare('SELECT data FROM graphs ORDER BY updated_at DESC');
  const deleteGraphStmt = db.prepare('DELETE FROM graphs WHERE id = ?');

  const upsertConversation = db.prepare(
    'INSERT INTO conversations (id, data, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  );
  const selectConversation = db.prepare('SELECT data FROM conversations WHERE id = ?');
  const selectAllConversations = db.prepare(
    'SELECT data FROM conversations ORDER BY updated_at DESC',
  );

  // Backs everything that is not a graph or a conversation. Its own graphs/
  // conversations maps are simply never touched below.
  const runtime = createMemoryStore({ persistToDisk: opts.persistRunsToDisk });

  return {
    ...runtime,

    async hydrate() {
      // Graphs and conversations live in graphs.db already -- there is no
      // separate load step. Runs/steps still hydrate from the JSON snapshot
      // when PERSIST_TO_DISK is on.
      await runtime.hydrate();
    },

    /* -------------------------------------------------------------- Graphs */
    async saveGraph(graph: AgentGraph) {
      upsertGraph.run(graph.id, JSON.stringify(graph), graph.updatedAt);
      return graph;
    },
    async getGraph(id: string) {
      const row = selectGraph.get(id) as Row | undefined;
      return row ? (JSON.parse(row.data) as AgentGraph) : null;
    },
    async listGraphs() {
      return (selectAllGraphs.all() as unknown as Row[]).map(
        (row) => JSON.parse(row.data) as AgentGraph,
      );
    },
    async deleteGraph(id: string) {
      return deleteGraphStmt.run(id).changes > 0;
    },

    /* ------------------------------------------------------- Conversations */
    async saveConversation(conversation: Conversation) {
      upsertConversation.run(conversation.id, JSON.stringify(conversation), conversation.updatedAt);
      return conversation;
    },
    async getConversation(id: string) {
      const row = selectConversation.get(id) as Row | undefined;
      return row ? (JSON.parse(row.data) as Conversation) : null;
    },
    async listConversations() {
      return (selectAllConversations.all() as unknown as Row[]).map(
        (row) => JSON.parse(row.data) as Conversation,
      );
    },
  };
}
