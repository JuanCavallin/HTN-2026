import type { RequestHandler } from 'express';
import { newId } from '../../lib/ids.js';

/**
 * Attaches a request id and logs one line per request.
 *
 * There is deliberately no auth here. Users, sessions and JWTs are out of scope —
 * a demo user is assumed. When auth is actually needed, this is where it goes.
 */
export const requestContext: RequestHandler = (req, res, next) => {
  req.requestId = newId('req');
  res.setHeader('X-Request-Id', req.requestId);

  const started = Date.now();
  res.on('finish', () => {
    // SSE streams finish only on disconnect; the duration is the stream lifetime.
    console.log(
      '[api] ' +
        req.method +
        ' ' +
        req.originalUrl +
        ' -> ' +
        res.statusCode +
        ' (' +
        (Date.now() - started) +
        'ms)',
    );
  });

  next();
};
