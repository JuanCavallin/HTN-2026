/**
 * `{{node_id.path.to.value}}` resolution — how data moves along an edge.
 *
 * An edge says "B runs after A". A ref says "B uses A's output". They are
 * deliberately separate: an edge can exist for ordering alone, and a node can
 * read any upstream node's output without a direct edge to it.
 *
 * Two forms, and the difference matters:
 *
 *   "{{load.text}}"               -> the RAW value, type preserved
 *   "Summarise: {{load.text}}"    -> interpolated into the string
 *
 * The first form is what lets a node pass an object or a number downstream
 * without it being stringified on the way.
 *
 * `input` is reserved for the run's own variables: "{{input.target}}".
 */

export type RefScope = Record<string, unknown>;

/** A ref that is the ENTIRE string, e.g. "{{load.text}}". */
const WHOLE = /^\{\{\s*([A-Za-z0-9_$.-]+)\s*\}\}$/;

/** Any ref inside a larger string. */
const EMBEDDED = /\{\{\s*([A-Za-z0-9_$.-]+)\s*\}\}/g;

/** Walk a dot path. Returns undefined at the first missing hop. */
export function lookup(scope: RefScope, path: string): unknown {
  let current: unknown = scope;
  for (const key of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveString(text: string, scope: RefScope): unknown {
  const whole = WHOLE.exec(text);
  // Type-preserving form. An unresolvable whole-ref becomes undefined rather
  // than the literal "{{...}}", so a downstream zod parse fails loudly instead
  // of a template marker reaching a provider.
  if (whole) return lookup(scope, whole[1] as string);

  return text.replace(EMBEDDED, (_match, path: string) => stringify(lookup(scope, path)));
}

/**
 * Deep-resolve every string in a config object. Arrays and nested objects are
 * walked; anything else is returned as-is.
 */
export function resolveRefs<T>(value: T, scope: RefScope): T {
  if (typeof value === 'string') return resolveString(value, scope) as T;

  if (Array.isArray(value)) {
    return value.map((item) => resolveRefs(item, scope)) as unknown as T;
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveRefs(item, scope);
    }
    return out as T;
  }

  return value;
}

/** Every `{{ref}}` path mentioned anywhere in a value. Used to report bad refs. */
export function collectRefs(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(EMBEDDED)) found.add(match[1] as string);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, found);
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectRefs(item, found);
  }
  return found;
}
