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
 *
 * DEBUG LOGGING: every stage below logs to the terminal with a [hermes:live]
 * prefix — spawn, connect, session start, EVERY update drain() receives from
 * Hermes (chunk, tool call, or an unrecognised kind — see the note in drain()
 * about why that last one matters), and every poll. This is deliberately
 * verbose: when a task sits at "running" for a long time, the only way to
 * tell "slow but working" from "actually stuck" apart is to watch what
 * drain() is receiving in real time. hermes-acp's OWN stderr is also
 * inherited (see the spawn() call below), so Hermes's internal logs are
 * already interleaved with these — this adapter's logs are what OUR side did
 * with what Hermes sent, not a replacement for Hermes's own output.
 * ============================================================================
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { AgentRuntimeAdapter, ProviderErrorCode, ProviderResult } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';

function debug(...args: unknown[]): void {
  console.log('[hermes:live]', ...args);
}

/** First `n` chars, whitespace collapsed, so a log line stays one line. */
function preview(text: string, n = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

interface TaskRecord {
  status: 'running' | 'done' | 'failed';
  log: string[];
  /**
   * Derived from `toolCallsById` after every update — see the dedupe note on
   * that field. This is what pollTask() actually returns.
   */
  toolCalls: { tool: string; args?: unknown; at: string }[];
  /**
   * ONE ACP tool call arrives as a `tool_call` (pending, carries a title) plus
   * one or more `tool_call_update`s (status only, no title -- see the ACP SDK
   * type: ToolCallUpdate.title is "update the title", so an update that
   * doesn't change it omits the field entirely). Keying by toolCallId is what
   * stops "web_search" (the tool_call) and "tc-a6594ec2" (its completion
   * update, same call, no title to repeat) from being recorded as two
   * different tool calls -- which is exactly the duplicate pattern a real
   * ledger showed: every titled call followed by an untitled twin.
   */
  toolCallsById: Map<string, { tool: string; at: string }>;
  result?: unknown;
  error?: string;
  session: Awaited<ReturnType<acp.SessionBuilder['start']>>;
  /** When startTask created this record. Basis for every elapsed-time log below. */
  startedAt: number;
  /** Bumped on EVERY update drain() receives, of any kind. See pollTask. */
  lastActivityAt: number;
  /** How many updates drain() has received. A quick "is anything happening" number. */
  updateCount: number;
  /** Running total of streamed text, for a poll-time progress readout. */
  chunkChars: number;
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

function failure<T>(
  op: string,
  started: number,
  code: ProviderErrorCode,
  message: string,
): ProviderResult<T> {
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

      debug('spawning "uv run hermes-acp" in', cfg.cwd);
      const spawnStarted = Date.now();

      // NOT shell:true. `uv` is a real .exe on PATH — Windows CreateProcess
      // resolves that directly. shell:true instead routes through cmd.exe
      // (resolved via process.env.ComSpec), which broke under `tsx watch`
      // specifically (ComSpec apparently doesn't survive tsx watch's nested
      // process spawn) with `spawn C:\WINDOWS\system32\cmd.exe ENOENT` —
      // reproduced live, not theoretical. Passing argv separately here also
      // sidesteps shell quoting entirely, which is more robust regardless.
      hermesProc = spawn('uv', ['run', 'hermes-acp'], {
        cwd: cfg.cwd,
        stdio: ['pipe', 'pipe', 'inherit'], // stderr inherited: Hermes's own logs stay visible
      });

      // spawn() returning tells you nothing about whether the process
      // actually started — a bad path/executable surfaces asynchronously as
      // an 'error' event, and an EventEmitter's UNHANDLED 'error' event is
      // fatal to the entire Node process. This is exactly what took down the
      // whole API server (and with it the web dev server's proxy) the one
      // time this fired — always attach this before doing anything else.
      await new Promise<void>((resolve, reject) => {
        hermesProc!.once('error', reject);
        hermesProc!.once('spawn', () => {
          hermesProc!.removeListener('error', reject);
          resolve();
        });
      });
      debug(
        'hermes-acp process spawned, pid',
        hermesProc.pid,
        '(' + (Date.now() - spawnStarted) + 'ms)',
      );

      hermesProc.on('exit', (code, signal) => {
        console.error(
          '[hermes:live] hermes-acp exited (code ' +
            code +
            ', signal ' +
            signal +
            ') — ' +
            tasks.size +
            ' task(s) were tracked at exit; any still "running" will now hang until they hit their own timeout',
        );
        connection = null;
        connecting = null;
      });
      // A LATER error (e.g. the process dies mid-session) must not crash the
      // server either — same reasoning as above, ongoing rather than one-shot.
      hermesProc.on('error', (err) => {
        console.error('[hermes:live] hermes-acp process error:', err.message);
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
          return Promise.resolve({
            outcome: { outcome: 'selected' as const, optionId: deny.optionId },
          });
        })
        .onRequest(acp.methods.client.fs.writeTextFile, async () => ({}))
        .onRequest(acp.methods.client.fs.readTextFile, async () => ({ content: '' }))
        .connect(stream);

      debug('ACP stream connected, sending initialize...');
      await conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
      debug('initialize handshake OK (' + (Date.now() - spawnStarted) + 'ms since spawn)');

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

  /**
   * Runs in the background from startTask; pollTask only ever reads `record`.
   *
   * DEBUG NOTE: the `else` branch below is not decorative. Only two
   * `sessionUpdate` kinds were ever handled (a text chunk, a tool call) — ANY
   * other kind ACP sends (a plan update, a thought chunk, a mode change,
   * whatever this Hermes build emits that this code was not written against)
   * fell through both branches and vanished: no log line, no record mutation,
   * nothing. A task that is actually making progress through updates of a
   * kind this file does not recognise would look IDENTICAL, from the
   * outside, to one that is truly hung — that gap is now closed by logging
   * and counting every update kind, recognised or not.
   */
  async function drain(record: TaskRecord): Promise<void> {
    const chunks: string[] = [];
    const tag = record.session.sessionId.slice(0, 8);

    function touch(): void {
      record.lastActivityAt = Date.now();
      record.updateCount += 1;
    }

    try {
      for (;;) {
        const message = await record.session.nextUpdate();

        if (message.kind === 'stop') {
          record.result = { text: chunks.join('') };
          record.log.push('stop: ' + message.stopReason);
          record.status = 'done';
          debug(
            tag,
            'stopped: reason=' + message.stopReason,
            '| elapsed=' + (Date.now() - record.startedAt) + 'ms',
            '| updates=' + record.updateCount,
            '| chunkChars=' + record.chunkChars,
            '| toolCalls=' + record.toolCalls.length,
          );
          return;
        }

        const update = message.notification.update;

        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          chunks.push(update.content.text);
          record.chunkChars += update.content.text.length;
          touch();
          debug(
            tag,
            'chunk (+' + update.content.text.length + ' chars):',
            preview(update.content.text),
          );
        } else if (
          update.sessionUpdate === 'tool_call' ||
          update.sessionUpdate === 'tool_call_update'
        ) {
          // Prefer THIS event's title; fall back to whatever we already have
          // for this toolCallId (from the initiating tool_call); fall back to
          // the raw id only if we have genuinely never seen a title for it.
          const existing = record.toolCallsById.get(update.toolCallId);
          const tool = update.title ?? existing?.tool ?? update.toolCallId;
          record.toolCallsById.set(update.toolCallId, { tool, at: new Date().toISOString() });
          record.toolCalls = [...record.toolCallsById.values()];
          touch();
          debug(
            tag,
            update.sessionUpdate + ':',
            tool,
            '(id=' +
              update.toolCallId +
              ', ' +
              record.toolCallsById.size +
              ' distinct call(s) so far)',
          );
        } else {
          // See the DEBUG NOTE above — this branch existing at all is the fix.
          touch();
          debug(
            tag,
            'unhandled update kind:',
            update.sessionUpdate,
            '(counted as activity, not acted on)',
          );
        }
      }
    } catch (err) {
      record.status = 'failed';
      record.error = (err as Error).message;
      console.error(
        '[hermes:live]',
        tag,
        'drain loop failed after',
        Date.now() - record.startedAt,
        'ms,',
        record.updateCount,
        'update(s) received:',
        (err as Error).message,
      );
      if ((err as Error).stack) console.error((err as Error).stack);
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

        const now = Date.now();
        const record: TaskRecord = {
          status: 'running',
          log: ['started'],
          toolCalls: [],
          toolCallsById: new Map(),
          session,
          startedAt: now,
          lastActivityAt: now,
          updateCount: 0,
          chunkChars: 0,
        };
        tasks.set(session.sessionId, record);

        debug(
          session.sessionId.slice(0, 8),
          'started | goal:',
          preview(input.goal),
          '| tools exposed:',
          (input.tools ?? []).length ? (input.tools ?? []).join(', ') : '(none)',
          '| session start took',
          Date.now() - started,
          'ms',
        );

        session.prompt(
          input.context
            ? input.goal + '\n\nContext:\n' + JSON.stringify(input.context)
            : input.goal,
        );
        void drain(record);

        return {
          ok: true,
          data: { taskId: session.sessionId },
          meta: meta('startTask', started, 'hermes-acp://local'),
        };
      } catch (err) {
        console.error('[hermes:live] startTask failed:', (err as Error).message);
        return failure('startTask', started, 'UPSTREAM', (err as Error).message);
      }
    },

    async pollTask(taskId) {
      const started = Date.now();
      const record = tasks.get(taskId);
      if (!record) return failure('pollTask', started, 'BAD_INPUT', 'Unknown taskId: ' + taskId);

      const tag = taskId.slice(0, 8);
      const elapsedMs = Date.now() - record.startedAt;
      const sinceActivityMs = Date.now() - record.lastActivityAt;

      // THE key debug line for "is this actually stuck". Every poll from
      // orchestrator.ts prints exactly what this adapter knows right now:
      // how long it's been running, how long since anything actually
      // happened, and what it has to show for it so far.
      debug(
        tag,
        'poll | status=' + record.status,
        '| elapsed=' + (elapsedMs / 1000).toFixed(1) + 's',
        '| idle=' + (sinceActivityMs / 1000).toFixed(1) + 's',
        '| updates=' + record.updateCount,
        '| chunkChars=' + record.chunkChars,
        '| toolCalls=' + record.toolCalls.length,
      );

      const lastActivityAt = new Date(record.lastActivityAt).toISOString();

      if (record.status === 'running') {
        return {
          ok: true,
          data: { status: 'running', log: record.log, lastActivityAt },
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
          lastActivityAt,
        },
        meta: meta('pollTask', started, 'hermes-acp://local'),
      };
    },

    async cancelTask(taskId) {
      const started = Date.now();
      const record = tasks.get(taskId);
      if (!record) return { ok: true, data: null, meta: meta('cancelTask', started, null) };

      const tag = taskId.slice(0, 8);
      debug(
        tag,
        'cancelling | elapsed=' + ((Date.now() - record.startedAt) / 1000).toFixed(1) + 's',
        '| idle=' + ((Date.now() - record.lastActivityAt) / 1000).toFixed(1) + 's',
        '| updates=' + record.updateCount,
        '| toolCalls=' + record.toolCalls.length,
        record.updateCount === 0
          ? '<- ZERO updates ever received: likely never got a first response, not a mid-task hang'
          : '',
      );

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
