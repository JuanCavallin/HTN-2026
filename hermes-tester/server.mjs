/**
 * Hermes connectivity test harness.
 *
 * Minimal, standalone — deliberately OUTSIDE the pnpm workspace (this folder
 * isn't listed in pnpm-workspace.yaml) and outside apps/api. Its only job is
 * to prove the Hermes ACP connection works end to end from a real UI, with
 * zero risk to a teammate's in-progress Jev work: nothing here imports
 * apps/api/src/providers/jev/** or packages/shared.
 *
 * Tool eligibility is a hardcoded mock (mockJev.mjs), not a live decision.
 *
 * Run:  npm install && npm start
 * Then: http://localhost:5055
 */

import express from 'express';
import { spawn } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { mockJevRoute } from './mockJev.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// EDIT if your clone lives elsewhere.
const HERMES_DIR = 'C:\\Users\\juanc\\Local_Dev\\HTN-2026\\hermes-agent';
const PORT = 5055;

let connection = null;
let session = null;
let hermesProc = null;
let lastRoute = null;
/**
 * Serializes prompts against the one shared session — a test tool needs no
 * real concurrency, just "don't send two prompts to Hermes at once."
 *
 * `.catch(() => {})` at each link is load-bearing: without it, once one
 * prompt rejects (e.g. the timeout above), `queueTail` becomes a rejected
 * promise, and every future `queueTail.then(...)` short-circuits straight to
 * that old rejection WITHOUT ever calling sendPrompt again — the whole
 * server silently wedges after the first bad prompt. This is exactly what
 * happened when a browser-tool prompt hung: no error surfaced, but nothing
 * afterward would respond either, ever, until the process was restarted.
 */
let queueTail = Promise.resolve();

/**
 * No interactive terminal is attached to answer Hermes's permission requests
 * here (unlike the CLI probe script, which used readline). Auto-approving
 * "allow once" is fine for a connectivity test; NEVER do this in the real
 * product — that's exactly what core/approvalGate.ts exists to replace.
 */
async function autoApprovePermission(params) {
  console.log('[hermes-tester] auto-approving permission: ' + params.toolCall.title);
  const chosen = params.options.find((o) => o.optionId === 'allow_once') ?? params.options[0];
  return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
}

async function connectToHermes() {
  console.log('[hermes-tester] spawning hermes-acp in ' + HERMES_DIR);

  // NOT shell:true — see apps/api/src/providers/hermes/live.ts for why: it
  // routes through cmd.exe (via process.env.ComSpec), which can go missing
  // under some wrapped process contexts and throws `spawn ...cmd.exe ENOENT`.
  // `uv` is a real .exe on PATH; spawn it directly.
  hermesProc = spawn('uv', ['run', 'hermes-acp'], {
    cwd: HERMES_DIR,
    stdio: ['pipe', 'pipe', 'inherit'], // stderr inherited so Hermes's own logs show in this terminal
  });

  // An unhandled 'error' event crashes the whole process — always attach
  // this before doing anything else with the child.
  await new Promise((resolve, reject) => {
    hermesProc.once('error', reject);
    hermesProc.once('spawn', () => {
      hermesProc.removeListener('error', reject);
      resolve();
    });
  });

  hermesProc.on('exit', (code) => {
    console.error('[hermes-tester] hermes-acp exited (code ' + code + '). Restart this server to reconnect.');
    connection = null;
    session = null;
  });
  hermesProc.on('error', (err) => {
    console.error('[hermes-tester] hermes-acp process error:', err.message);
    connection = null;
    session = null;
  });

  const input = Writable.toWeb(hermesProc.stdin);
  const output = Readable.toWeb(hermesProc.stdout);
  const stream = acp.ndJsonStream(input, output);

  // .connect() (not .connectWith()) — persists for the life of this process,
  // so the same session survives across many separate HTTP requests.
  connection = acp
    .client({ name: 'hermes-tester' })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => autoApprovePermission(ctx.params))
    .onRequest(acp.methods.client.fs.writeTextFile, async () => ({}))
    .onRequest(acp.methods.client.fs.readTextFile, async () => ({ content: '' }))
    .connect(stream);

  const agent = connection.agent;

  const init = await agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  console.log('[hermes-tester] initialize ok — protocol v' + init.protocolVersion);

  lastRoute = mockJevRoute('connectivity test');
  console.log('[hermes-tester] mock Jev route (NOT the real Jev):', lastRoute);

  // Best-effort attempt at scoping Hermes's toolset to the mock's preset list
  // via `_meta`. UNCONFIRMED CONVENTION: Hermes's Python side takes an
  // `enabled_toolsets` kwarg internally (acp_adapter/session.py), but whether
  // it reads that out of ACP's `_meta` extensibility field on `session/new`
  // has not been verified against Hermes's own server code — this is a
  // documented ACP extension point (SDK's own comment: "pass a full
  // NewSessionRequest when you need MCP servers, _meta, or additional
  // session fields"), not a confirmed Hermes convention. Harmless if Hermes
  // ignores it. Check the startup logs' "tool_search activated (tier N): X
  // kept" line — compare that count against a run without this to see
  // whether it actually took effect.
  const request = agent.buildSession(HERMES_DIR).toRequest();
  request._meta = { enabled_toolsets: lastRoute.exposedTools };

  session = await agent.buildSession(request).start();
  console.log('[hermes-tester] session created: ' + session.sessionId);
}

/**
 * A prompt that needs a tool Hermes doesn't actually have configured (e.g. no
 * browser backend is authenticated — see the `check_fn ... returned False`
 * lines in the startup log) can leave the model reasoning about a capability
 * it can't use, and the turn may never send a terminating `stop` message back
 * over ACP. Bound the wait so that shows up as a clear timeout, not a
 * request that hangs forever with no explanation.
 */
const PROMPT_TIMEOUT_MS = 45_000;

async function sendPrompt(text) {
  if (!session) await connectToHermes();

  session.prompt(text);

  const chunks = [];
  const toolCalls = [];

  const drain = (async () => {
    for (;;) {
      const message = await session.nextUpdate();
      if (message.kind === 'stop') {
        return { text: chunks.join(''), toolCalls, stopReason: message.stopReason };
      }
      const update = message.notification.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        chunks.push(update.content.text);
      } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        toolCalls.push({ label: update.title ?? update.toolCallId, status: update.status });
      }
    }
  })();

  const timeout = new Promise((_, reject) =>
    setTimeout(async () => {
      // A client-side timeout alone does NOT stop the turn on Hermes's side —
      // it keeps running, and its eventual `stop` message would land in this
      // same session's update queue and get misread as the *next* prompt's
      // response instead of this one's (confirmed: this caused an empty-text
      // response on the very next request during testing). session/cancel is
      // ACP's real mechanism for this — verified against the installed SDK's
      // own types, not guessed.
      try {
        await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
        console.log('[hermes-tester] sent session/cancel for the timed-out turn');
      } catch (err) {
        console.error('[hermes-tester] failed to send session/cancel:', err);
      }
      reject(
        new Error(
          'No response from Hermes within ' + PROMPT_TIMEOUT_MS / 1000 +
            's — likely stuck on a tool it does not actually have configured ' +
            '(check the terminal log for what it was trying to do). Sent session/cancel. ' +
            'Partial text so far: ' + JSON.stringify(chunks.join('')),
        ),
      );
    }, PROMPT_TIMEOUT_MS),
  );

  // Keep draining in the background even after a timeout "wins" the race
  // below — this is what lets the abandoned turn's real (now-cancelled) stop
  // message get consumed by ITS OWN loop instead of the next request's.
  drain.then(
    (result) => console.log('[hermes-tester] abandoned turn eventually settled: ' + result.stopReason),
    (err) => console.error('[hermes-tester] abandoned turn errored:', err),
  );

  return Promise.race([drain, timeout]);
}

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.post('/chat', async (req, res) => {
  const prompt = String(req.body?.prompt ?? '').trim();
  if (!prompt) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }

  // Chain off the previous tail regardless of how it settled, so one stuck
  // or failed prompt never blocks every request that comes after it.
  const runPromise = queueTail.catch(() => {}).then(() => sendPrompt(prompt));
  queueTail = runPromise.catch(() => {});

  try {
    const result = await runPromise;
    res.json({ ...result, mockRoute: lastRoute });
  } catch (err) {
    console.error('[hermes-tester] chat failed:', err);
    res.status(504).json({ error: String(err?.message ?? err) });
  }
});

app.get('/status', (_req, res) => {
  res.json({ connected: Boolean(session), sessionId: session?.sessionId ?? null, mockRoute: lastRoute });
});

app.listen(PORT, () => {
  console.log('[hermes-tester] http://localhost:' + PORT);
  connectToHermes().catch((err) => console.error('[hermes-tester] initial connect failed:', err));
});

function shutdown() {
  console.log('\n[hermes-tester] shutting down...');
  session?.dispose();
  hermesProc?.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
