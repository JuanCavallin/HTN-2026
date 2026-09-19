/**
 * Zod request validation.
 *
 * NOTE FOR EXPRESS 5: `req.query` is a getter-only property and cannot be
 * reassigned. Validated data therefore lands on `req.valid` instead of mutating
 * the originals. Read it from there in handlers.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      valid?: { body?: unknown; query?: unknown; params?: unknown };
      requestId?: string;
    }
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

type Source = 'body' | 'query' | 'params';

export function validate(schema: ZodType, source: Source = 'body'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const raw = source === 'body' ? req.body : source === 'query' ? req.query : req.params;
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      next(
        new HttpError(400, 'VALIDATION_ERROR', 'Invalid request ' + source, {
          issues: parsed.error.issues,
        }),
      );
      return;
    }
    req.valid = { ...req.valid, [source]: parsed.data };
    next();
  };
}

/** Typed accessor so handlers do not cast at every call site. */
export function valid<T>(req: Request, source: Source): T {
  return req.valid?.[source] as T;
}

/**
 * Express 5 types a route param as `string | string[]` (repeated params). Every
 * param we declare is singular, so normalise once here rather than casting at
 * every call site.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
