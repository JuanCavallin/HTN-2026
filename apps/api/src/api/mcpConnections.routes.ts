import { Router } from 'express';
import { z } from 'zod';
import type { CreateMcpConnectionInput } from '@htn/shared';
import { McpConnectionNotFoundError } from '../core/mcp/connections.js';
import { mcpConnections } from '../services/runtime.js';
import { HttpError, param, valid, validate } from './middleware/validate.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().url(),
  enabled: z.boolean().optional(),
  headerEnv: z.record(z.string(), z.string()).optional(),
});

const enabledSchema = z.object({ enabled: z.boolean() });

export const mcpConnectionsRouter = Router();

mcpConnectionsRouter.get('/mcp-connections', async (_req, res) => {
  res.json({ connections: await mcpConnections.list() });
});

mcpConnectionsRouter.post('/mcp-connections', validate(createSchema), async (req, res) => {
  try {
    const connection = await mcpConnections.create(valid<CreateMcpConnectionInput>(req, 'body'));
    res.status(201).json({ connection });
  } catch (error) {
    throw connectionError(error);
  }
});

mcpConnectionsRouter.post('/mcp-connections/:id/refresh', async (req, res) => {
  try {
    res.json({ connection: await mcpConnections.refresh(param(req, 'id')) });
  } catch (error) {
    throw connectionError(error);
  }
});

mcpConnectionsRouter.patch('/mcp-connections/:id', validate(enabledSchema), async (req, res) => {
  try {
    const body = valid<{ enabled: boolean }>(req, 'body');
    res.json({
      connection: await mcpConnections.setEnabled(param(req, 'id'), body.enabled),
    });
  } catch (error) {
    throw connectionError(error);
  }
});

mcpConnectionsRouter.delete('/mcp-connections/:id', async (req, res) => {
  try {
    await mcpConnections.remove(param(req, 'id'));
    res.status(204).end();
  } catch (error) {
    throw connectionError(error);
  }
});

function connectionError(error: unknown): Error {
  if (error instanceof McpConnectionNotFoundError) {
    return new HttpError(404, 'NOT_FOUND', error.message);
  }
  const message = error instanceof Error ? error.message : 'MCP connection failed.';
  const conflict = message.includes('already uses this URL');
  return new HttpError(
    conflict ? 409 : 400,
    conflict ? 'CONFLICT' : 'MCP_CONNECTION_ERROR',
    message,
  );
}
