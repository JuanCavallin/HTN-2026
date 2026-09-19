/**
 * Uniform error responses.
 *
 * Express 5 propagates rejected promises from async handlers to here
 * automatically, so route handlers need no try/catch wrapper.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ApprovalConflictError } from '../../services/approvals.service.js';
import { ValidationError } from '../../services/runs.service.js';
import { NotFoundError } from '../../store/types.js';
import { HttpError } from './validate.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'No route for ' + req.method + ' ' + req.path },
  });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) return; // e.g. an SSE stream already started

  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof ValidationError) {
    res.status(400).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof ApprovalConflictError) {
    res.status(409).json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof NotFoundError) {
    res.status(404).json({ error: { code: err.code, message: err.message } });
    return;
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  console.error('[api] unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
};
