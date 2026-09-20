/**
 * Uniform error responses.
 *
 * Express 5 propagates rejected promises from async handlers to here
 * automatically, so route handlers need no try/catch wrapper.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ApprovalConflictError } from '../../services/approvals.service.js';
import {
  GraphConflictError,
  GraphNotFoundError,
  GraphValidationError,
} from '../../services/graphs.service.js';
import { RunNotActiveError, ValidationError } from '../../services/runs.service.js';
import { SynthesisError } from '../../services/synthesis.service.js';
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

  if (err instanceof GraphValidationError) {
    res.status(400).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // The model could not produce a usable graph in two attempts. 422 rather
  // than 500: the request was well formed, the result was not usable.
  if (err instanceof SynthesisError) {
    res.status(422).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof GraphNotFoundError) {
    res.status(404).json({ error: { code: err.code, message: err.message } });
    return;
  }

  // Someone else saved this graph first. The client should re-read and retry —
  // chat and the canvas both write, so this is a real race, not a rare one.
  if (err instanceof ApprovalConflictError || err instanceof GraphConflictError) {
    res.status(409).json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof NotFoundError) {
    res.status(404).json({ error: { code: err.code, message: err.message } });
    return;
  }

  // The run exists but this process isn't executing it -- already terminal,
  // or orphaned by a restart. A retry against a different process won't fix
  // this either, but it's the caller's state to know about, not a server bug.
  if (err instanceof RunNotActiveError) {
    res.status(409).json({ error: { code: err.code, message: err.message } });
    return;
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  console.error('[api] unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
};
