/**
 * SQLite-backed persistence for graphs, conversations, and runs.
 *
 * Everything else (steps, approvals, egress, PII spans, schedule decisions,
 * the event log) stays on the in-memory Store: it is per-run scratch data
 * written on the interpreter's hot path -- many small appends per second
 * while a run streams over SSE -- and normalizing THAT into SQL too is a
 * materially bigger schema project for no concrete need yet. PERSIST_TO_DISK's
 * JSON snapshot still covers it if a restart needs to survive; only a run's
 * own existence/summary/result is durable unconditionally now, same
 * asymmetry as before, just narrower.
 *
 * Runs moved in here (not just graphs/conversations) because "every run
 * launched against this graph" needs to be an indexed query, not a linear
 * scan of an in-memory Map -- see Run.graphId and the runs table's index below.
 *
 * Uses node's built-in `node:sqlite` (stable since Node 22.5, no native
 * addon) instead of better-sqlite3, so there is nothing to compile -- and
 * nothing new in package.json.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentGraph, Conversation, Run } from '@htn/shared';
import { nowIso } from '../lib/ids.js';
import { createMemoryStore } from './memory.js';
import { NotFoundError, type ListRunsFilter, type Store } from './types.js';

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
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      graph_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_graph_id ON runs (graph_id, created_at);
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

  const upsertRun = db.prepare(
    'INSERT INTO runs (id, kind, graph_id, status, created_at, updated_at, data) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, graph_id = excluded.graph_id, ' +
      'status = excluded.status, updated_at = excluded.updated_at, data = excluded.data',
  );
  const selectRun = db.prepare('SELECT data FROM runs WHERE id = ?');

  function writeRun(run: Run): void {
    upsertRun.run(
      run.id,
      run.kind,
      run.graphId ?? null,
      run.status,
      run.createdAt,
      run.updatedAt,
      JSON.stringify(run),
    );
  }

  // Backs everything that is not a graph, a conversation, or a run. Its own
  // graphs/conversations/runs maps are simply never touched below.
  const runtime = createMemoryStore({ persistToDisk: opts.persistRunsToDisk });

  return {
    ...runtime,

    async hydrate() {
      // Graphs, conversations and runs live in graphs.db already -- there is
      // no separate load step for them. Steps/egress/etc still hydrate from
      // the JSON snapshot when PERSIST_TO_DISK is on.
      await runtime.hydrate();
    },

    /* ---------------------------------------------------------------- Runs */
    async createRun(run: Run) {
      writeRun(run);
      return run;
    },
    async getRun(id: string) {
      const row = selectRun.get(id) as Row | undefined;
      return row ? (JSON.parse(row.data) as Run) : null;
    },
    async listRuns(filter: ListRunsFilter = {}) {
      // Built per call rather than pre-prepared like the statements above --
      // the filter shape is genuinely dynamic (any combination of
      // status/kind/graphId) and this list is not the hot path a live run's
      // step/egress writes are.
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (filter.status) {
        clauses.push('status = ?');
        params.push(filter.status);
      }
      if (filter.kind) {
        clauses.push('kind = ?');
        params.push(filter.kind);
      }
      if (filter.graphId) {
        clauses.push('graph_id = ?');
        params.push(filter.graphId);
      }
      const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
      const rows = db
        .prepare('SELECT data FROM runs ' + where + ' ORDER BY created_at DESC LIMIT ?')
        .all(...params, filter.limit ?? 50) as unknown as Row[];
      return rows.map((row) => JSON.parse(row.data) as Run);
    },
    async patchRun(id: string, patch: Partial<Run>) {
      const row = selectRun.get(id) as Row | undefined;
      if (!row) throw new NotFoundError('Run', id);
      const existing = JSON.parse(row.data) as Run;
      const next: Run = { ...existing, ...patch, id, updatedAt: nowIso() };
      writeRun(next);
      return next;
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
