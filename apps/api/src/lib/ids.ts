import { randomUUID } from 'node:crypto';

/** Short, URL-safe, sortable-enough id. Prefixed so ids are self-describing in logs. */
export function newId(prefix: string): string {
  return prefix + '_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

export function nowIso(): string {
  return new Date().toISOString();
}
