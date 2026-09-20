import { Router, type Response } from 'express';
import { config } from '../config.js';
import type { OpenAiChatRequest } from '../core/modelGateway/service.js';
import { modelGateway } from '../services/runtime.js';

export const modelGatewayRouter = Router();

modelGatewayRouter.get('/models', (_req, res) => {
  const created = Math.floor(Date.now() / 1000);
  res.json({
    object: 'list',
    data: [
      { id: 'agentos-router', object: 'model', created, owned_by: 'agentos' },
      ...modelGateway.listModels().map((route) => ({
        id: route.id,
        object: 'model',
        created,
        owned_by: route.providerId,
      })),
    ],
  });
});

modelGatewayRouter.get('/models/:id', (req, res) => {
  res.json({
    id: req.params.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'agentos',
    context_length: 131_072,
  });
});

// Model metadata is non-sensitive and some local-runtime probes do not attach
// bearer credentials. Completions below remain authenticated.
/**
 * The bearer token, with one specific client quirk absorbed.
 *
 * Hermes resolves its `key_env` value and sends it WRAPPED IN DOUBLE QUOTES:
 * the subprocess reads the env var correctly (verified -- the child sees 13
 * chars, unquoted), and the quotes appear only in the Authorization header it
 * builds. That is Hermes's own behaviour and not something this side can fix,
 * and the symptom is an unexplainable 401 against a key that is demonstrably
 * correct on both ends.
 *
 * So exactly one extra form is accepted: a token wrapped in symmetric double
 * quotes. The comparison is still against the same fixed value, so this widens
 * what is accepted by one string, not by a class of strings.
 */
function bearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const raw = authorization.slice('Bearer '.length);
  return raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
}

/**
 * Hermes's placeholder for "this endpoint is local, so it needs no auth".
 *
 * It is not a guess: hermes-agent substitutes this literal for any LOOPBACK
 * base_url with no usable secret, in several independent resolution paths
 * (hermes_cli/runtime_provider_custom.py, agent/auxiliary_client.py). Our
 * gateway is http://127.0.0.1:<port>/v1, so Hermes will never send the real
 * token no matter what environment it is given -- verified by trying both
 * `key_env` and OPENAI_API_KEY, and watching it send this instead.
 */
const HERMES_LOCAL_PLACEHOLDER = 'no-key-required';

/** True only for a request that actually arrived over the loopback interface. */
function isLoopback(req: { ip?: string; socket: { remoteAddress?: string } }): boolean {
  const address = req.ip ?? req.socket.remoteAddress ?? '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

modelGatewayRouter.use((req, res, next) => {
  const authorization = req.header('authorization');
  const token = bearerToken(authorization);

  // The exemption is as narrow as the behaviour it accommodates: this exact
  // placeholder, and only from a caller on the loopback interface. A remote
  // caller presenting it is still rejected, and every other token is still
  // compared against the configured one.
  if (token === HERMES_LOCAL_PLACEHOLDER && isLoopback(req)) {
    next();
    return;
  }

  if (token !== config.modelGateway.apiKey) {
    // SAY WHICH KIND OF WRONG. "Invalid token" alone sends you checking a key
    // that is already correct; the common causes are a missing header entirely
    // (the client never picked up its key_env) and a non-Bearer scheme. Only
    // the shape is logged -- never the token, and never the expected value.
    const shape = !authorization
      ? 'no Authorization header was sent'
      : !authorization.startsWith('Bearer ')
        ? 'the Authorization header is not a Bearer token'
        : authorization === 'Bearer '
          ? 'the Bearer token was empty'
          : 'the Bearer token did not match (length ' + (authorization.length - 7) + ')';
    // Local dev token only: show the ends so a mismatch is identifiable
    // without printing a credential in full.
    const raw = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    const hint =
      raw.length > 6 ? raw.slice(0, 3) + '...' + raw.slice(-3) : raw.length > 0 ? raw : '(none)';
    console.warn('[model-gateway] rejected a call: ' + shape + ' [' + hint + ']');
    res.status(401).json({
      error: { message: 'Invalid AgentOS gateway token: ' + shape, type: 'authentication_error' },
    });
    return;
  }
  next();
});

modelGatewayRouter.post('/chat/completions', async (req, res) => {
  try {
    const input = req.body as OpenAiChatRequest;
    const completion = await modelGateway.complete(input);
    res.setHeader('X-AgentOS-Run-Id', completion.runId);
    res.setHeader('X-AgentOS-Session-Id', completion.sessionStateId);

    if (input.stream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      writeChunk(res, completion, { role: 'assistant' }, null);
      writeChunk(
        res,
        completion,
        completion.toolCalls.length > 0
          ? { tool_calls: completion.toolCalls.map((toolCall, index) => ({ index, ...toolCall })) }
          : { content: completion.text },
        null,
      );
      writeChunk(res, completion, {}, completion.toolCalls.length > 0 ? 'tool_calls' : 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.json({
      id: completion.id,
      object: 'chat.completion',
      created: completion.created,
      model: completion.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: completion.text || null,
            ...(completion.toolCalls.length > 0 ? { tool_calls: completion.toolCalls } : {}),
          },
          finish_reason: completion.toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: completion.tokensIn,
        completion_tokens: completion.tokensOut,
        total_tokens: completion.tokensIn + completion.tokensOut,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const conflict = message.startsWith('No active') || message.startsWith('Multiple active');
    res.status(conflict ? 409 : 502).json({
      error: { message, type: conflict ? 'session_state_error' : 'gateway_error' },
    });
  }
});

function writeChunk(
  res: Response,
  completion: Awaited<ReturnType<typeof modelGateway.complete>>,
  delta: Record<string, unknown>,
  finishReason: string | null,
): void {
  res.write(
    'data: ' +
      JSON.stringify({
        id: completion.id,
        object: 'chat.completion.chunk',
        created: completion.created,
        model: completion.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      }) +
      '\n\n',
  );
}
