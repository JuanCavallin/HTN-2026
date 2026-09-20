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
modelGatewayRouter.use((req, res, next) => {
  const authorization = req.header('authorization');
  if (authorization !== 'Bearer ' + config.modelGateway.apiKey) {
    res.status(401).json({
      error: { message: 'Invalid AgentOS gateway token.', type: 'authentication_error' },
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
