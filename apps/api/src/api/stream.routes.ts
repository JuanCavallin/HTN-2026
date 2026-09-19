/**
 * Server-Sent Events.
 *
 * Chosen over WebSocket because traffic is ~99% server->client; the approve and
 * cancel paths are ordinary POSTs that get zod validation and status codes for
 * free. EventSource also gives reconnect and replay (Last-Event-ID) at no cost.
 *
 * THREE FOOTGUNS, ALL HANDLED BELOW — do not remove any of them:
 *   1. X-Accel-Buffering: no, and NEVER add compression() to this app. gzip
 *      buffering makes a working stream look like a hung backend.
 *   2. A heartbeat comment every 15s, or proxies drop an idle connection.
 *   3. The subscribe-before-replay ordering, which closes the race where an event
 *      emitted between "read history" and "start listening" is lost forever.
 */

import { Router } from 'express';
import type { Response } from 'express';
import type { StoredEvent } from '@htn/shared';
import { bus, store } from '../services/runtime.js';
import { HttpError, param } from './middleware/validate.js';

export const streamRouter: Router = Router();

const HEARTBEAT_MS = 15_000;

function openStream(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

function parseCursor(headerValue: unknown, queryValue: unknown): number {
  const raw = Number(headerValue ?? queryValue ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

streamRouter.get('/runs/:id/stream', async (req, res) => {
  const runId = param(req, 'id');

  const run = await store.getRun(runId);
  if (!run) throw new HttpError(404, 'NOT_FOUND', 'Run not found');

  openStream(res);

  const since = parseCursor(req.headers['last-event-id'], req.query.since);
  let lastSent = since;

  const write = (stored: StoredEvent): void => {
    // Dedupe: an event can arrive both from replay and from the live buffer.
    if (stored.seq <= lastSent) return;
    lastSent = stored.seq;
    res.write('id: ' + stored.seq + '\n');
    res.write('data: ' + JSON.stringify(stored.event) + '\n\n');
  };

  // Subscribe FIRST and buffer, so nothing emitted during replay is missed.
  let replaying = true;
  const buffered: StoredEvent[] = [];
  const unsubscribe = bus.subscribe(runId, (stored) => {
    if (replaying) buffered.push(stored);
    else write(stored);
  });

  try {
    for (const stored of await store.eventsSince(runId, since)) write(stored);
  } finally {
    replaying = false;
    for (const stored of buffered) write(stored);
  }

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref?.();

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });

  // Intentionally never res.end() on completion: EventSource auto-reconnects when
  // the server closes the connection, which would loop. The client closes the
  // stream itself once the run reaches a terminal status.
});

/**
 * Global stream for the dashboard, so the run list updates live without one
 * connection per card. HTTP/1.1 allows ~6 connections per origin, so the web app
 * keeps at most two open: this one and (on a detail page) the per-run stream.
 */
streamRouter.get('/stream', (req, res) => {
  openStream(res);

  const unsubscribe = bus.subscribeAll((stored) => {
    res.write('id: ' + stored.seq + '\n');
    res.write('data: ' + JSON.stringify({ runId: stored.runId, ...stored.event }) + '\n\n');
  });

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref?.();

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
