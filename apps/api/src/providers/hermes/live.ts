/**
 * Hermes Agent (Nous Research) — LIVE ADAPTER, implemented.
 *
 * ============================================================================
 * Drives Hermes as a local subprocess over ACP (Agent Client Protocol) — NOT
 * an HTTP API. `uv run hermes-acp` speaks newline-delimited JSON-RPC over
 * stdio; we spawn it once per process lifetime (this factory is called once
 * and cached by providers/registry.ts) and create one ACP session PER TASK,
 * so unrelated subtasks never see each other's conversation history.
 *
 * VERIFIED, not guessed: this shape (persistent `.connect()`, `_meta` as the
 * documented extension point on `NewSessionRequest`, `session/cancel` as the
 * real cancellation notification, newline-delimited framing) was proven
 * against a real running Hermes install — a real prompt got a real answer, a
 * stuck tool call was genuinely cancelled and confirmed via Hermes's own
 * "Cancelled session" log line. See hermes-tester/ for that standalone proof.
 *
 * TWO HONEST LIMITS, DO NOT PAPER OVER THESE:
 *
 *   1. Tool restriction is BEST-EFFORT, NOT ENFORCED. `_meta.enabled_toolsets`
 *      below is a documented ACP extension point, but empirically it did NOT
 *      change Hermes's own tool_search "kept" count in testing. Real
 *      enforcement of "only Jev-approved tools" has to happen upstream — Jev
 *      must not hand this adapter a tool list wider than what's actually
 *      safe, because this adapter cannot currently guarantee Hermes will
 *      respect a narrower one.
 *
 *   2. Permission requests are DENIED BY DEFAULT, not routed to our own
 *      approval gate. Hermes's ACP server asks the client for permission
 *      before some tool calls; the correct integration is to route that
 *      callback through core/risk.ts's classify() and, when it lands on
 *      ask_human, the real Approval flow (waitForApproval). That wiring does
 *      not exist yet. Auto-approving in the meantime would violate the
 *      stated invariant "irreversible tools never enter an unattended
 *      harness allowlist" — denying by default is the safe placeholder.
 *      Fixing this is the next real step, not a nice-to-have.
 *
 * `startTask`/`pollTask` bridge ACP's session+event model onto this
 * interface's start/poll/cancel shape: startTask opens a session and returns
 * immediately with sessionId-as-taskId; a background drain loop updates an
 * in-memory record; pollTask just reads that record. This deliberately keeps
 * core/orchestrator.ts's existing bounded-polling loop untouched — see its
 * `pollIntervalMs`/`maxPolls` defaults, sized for real Hermes latency
 * (several seconds per call, 40+ seconds observed for a slow tool call).
 * ============================================================================
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { AgentRuntimeAdapter, ProviderErrorCode, ProviderResult } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';

interface TaskRecord {
  status: 'running' | 'done' | 'failed';
  log: string[];
  toolCalls: { tool: string; args?: unknown; at: string }[];
  result?: unknown;
  error?: string;
  session: Awaited<ReturnType<acp.SessionBuilder['start']>>;
}

function meta(op: string, started: number, destination: string | null) {
  return {
    provider: 'hermes' as const,
    op,
    mode: 'live' as const,
    latencyMs: Date.now() - started,
    destination,
  };
}

function failure<T>(op: string, started: number, code: ProviderErrorCode, message: string): ProviderResult<T> {
  return {
    ok: false,
    error: { code, message, retryable: code === 'UPSTREAM' || code === 'TIMEOUT' },
    meta: meta(op, started, null),
  };
}

export function createLiveHermes(cfg: ProviderConfig): AgentRuntimeAdapter {
  const tasks = new Map<string, TaskRecord>();
  let connection: acp.ClientConnection | null = null;
  let connecting: Promise<acp.ClientConnection> | null = null;
  let hermesProc: ChildProcess | null = null;

  async function connect(): Promise<acp.ClientConnection> {
    if (connection) return connection;
    if (connecting) return connecting;

    connecting = (async () => {
      if (!cfg.cwd) throw new Error('HERMES_CWD is not set');

      hermesProc = spawn('uv', ['run', 'hermes-acp'], {
        cwd: cfg.cwd,
        stdio: ['pipe', 'pipe', 'inherit'], // stderr inherited: Hermes's own logs stay visible
        shell: true, // Windows needs this to resolve `uv` via PATH
      });
      hermesProc.on('exit', (code) => {
        console.error('[hermes:live] hermes-acp exited (code ' + code + ')');
        connection = null;
        connecting = null;
      });

      const input = Writable.toWeb(hermesProc.stdin!);
      const output = Readable.toWeb(hermesProc.stdout!);
      const stream = acp.ndJsonStream(input, output);

      const conn = acp
        .client({ name: 'htn-agentos' })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
          // FAIL CLOSED — see the file header. Never silently approve here.
          const options = ctx.params.options;
          console.warn(
            '[hermes:live] DENYING permission request (approval-gate wiring not built yet): ' +
              ctx.params.toolCall.title,
          );
          const deny = options.find((o) => o.optionId === 'deny') ?? options[options.length - 1];
          return Promise.resolve({ outcome: { outcome: 'selected' as const, optionId: deny.optionId } });
        })
        .onRequest(acp.methods.client.fs.writeTextFile, async () => ({}))
        .onRequest(acp.methods.client.fs.readTextFile, async () => ({ content: '' }))
        .connect(stream);

      await conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });

      connection = conn;
      return conn;
    })();

    try {
      return await connecting;
    } catch (err) {
      connecting = null;
      throw err;
    }
  }

  /** Runs in the background from startTask; pollTask only ever reads `record`. */
  async function drain(record: TaskRecord): Promise<void> {
    const chunks: string[] = [];
    try {
      for (;;) {
        const message = await record.session.nextUpdate();
        if (message.kind === 'stop') {
          record.result = { text: chunks.join('') };
          record.log.push('stop: ' + message.stopReason);
          record.status = 'done';
          return;
        }
        const update = message.notification.update;
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          chunks.push(update.content.text);
        } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          record.toolCalls.push({
            tool: 'title' in update ? (update.title ?? update.toolCallId) : update.toolCallId,
            at: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      record.status = 'failed';
      record.error = (err as Error).message;
    }
  }

  return {
    id: 'hermes',
    mode: 'live',
    capabilities: ['agent.runtime'],

    async health() {
      const started = Date.now();
      if (!cfg.cwd) return failure('health', started, 'AUTH', 'HERMES_CWD is not set');
      try {
        await connect();
        return { ok: true, data: {}, meta: meta('health', started, 'hermes-acp://local') };
      } catch (err) {
        return failure('health', started, 'UPSTREAM', (err as Error).message);
      }
    },

    async invoke(op) {
      return failure(op, Date.now(), 'BAD_INPUT', 'No generic invoke() op is defined for hermes.');
    },

    async startTask(input) {
      const started = Date.now();
      try {
        const conn = await connect();

        // Best-effort only — see file header limit #1. Never treat this as
        // an enforced boundary.
        const request = conn.agent.buildSession(cfg.cwd as string).toRequest();
        request._meta = { enabled_toolsets: input.tools ?? [] };
        const session = await conn.agent.buildSession(request).start();

        const record: TaskRecord = { status: 'running', log: ['started'], toolCalls: [], session };
        tasks.set(session.sessionId, record);

        session.prompt(input.context ? input.goal + '\n\nContext:\n' + JSON.stringify(input.context) : input.goal);
        void drain(record);

        return { ok: true, data: { taskId: session.sessionId }, meta: meta('startTask', started, 'hermes-acp://local') };
      } catch (err) {
        return failure('startTask', started, 'UPSTREAM', (err as Error).message);
      }
    },

    async pollTask(taskId) {
      const started = Date.now();
      const record = tasks.get(taskId);
      if (!record) return failure('pollTask', started, 'BAD_INPUT', 'Unknown taskId: ' + taskId);

      if (record.status === 'running') {
        return {
          ok: true,
          data: { status: 'running', log: record.log },
          meta: meta('pollTask', started, 'hermes-acp://local'),
        };
      }
      return {
        ok: true,
        data: {
          status: record.status,
          result: record.result,
          log: record.error ? [...record.log, record.error] : record.log,
          toolCalls: record.toolCalls,
        },
        meta: meta('pollTask', started, 'hermes-acp://local'),
      };
    },

    async cancelTask(taskId) {
      const started = Date.now();
      const record = tasks.get(taskId);
      if (!record) return { ok: true, data: null, meta: meta('cancelTask', started, null) };

      try {
        const conn = await connect();
        // Verified real: Hermes logs "Interrupt requested" / "Cancelled
        // session" in direct response to this. A client-side give-up alone
        // does NOT stop the turn on Hermes's side — this does.
        await conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: taskId });
      } catch (err) {
        console.error('[hermes:live] session/cancel failed:', err);
      }
      record.session.dispose();
      tasks.delete(taskId);
      return { ok: true, data: null, meta: meta('cancelTask', started, 'hermes-acp://local') };
    },
  };
}
