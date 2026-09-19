/**
 * PII detection and placeholder substitution.
 *
 * Deliberately a DETERMINISTIC regex tier, not a model. Structured identifiers
 * have formats and checksums; matching them with a pattern is faster, more
 * reliable, and far easier to defend than asking a 7B model to find them.
 *
 * The intended production shape is a three-tier hybrid:
 *   1. patterns (here)        — structured ids: SIN, account, DOB, email, phone
 *   2. a small local NER pass — names and addresses          [not built]
 *   3. a local LLM            — genuinely ambiguous spans    [not built]
 * Only tier 1 exists. Tiers 2 and 3 slot in behind the same detectPii signature.
 */

import type { PiiType } from '@htn/shared';

export interface DetectedSpan {
  type: PiiType;
  value: string;
  placeholder: string;
  start: number;
  end: number;
}

export interface RedactionResult {
  /** Text with every detected value swapped for its placeholder. */
  redacted: string;
  spans: DetectedSpan[];
}

interface Pattern {
  type: PiiType;
  regex: RegExp;
  /** Extra check beyond the pattern. */
  validate?: (value: string) => boolean;
}

/**
 * ORDER MATTERS — more specific patterns run first so a SIN is never eaten by
 * the generic number matcher.
 */
const PATTERNS: Pattern[] = [
  { type: 'email', regex: /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g },
  { type: 'dob', regex: /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g },
  {
    type: 'sin',
    regex: /\b\d{3}[-\s]?\d{3}[-\s]?\d{3}\b/g,
    validate: (v) => luhn(v.replace(/\D/g, '')),
  },
  { type: 'phone', regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g },
  { type: 'account', regex: /\b\d{5}-\d{3}-\d{7}\b/g },
  { type: 'student_id', regex: /\b2\d{7}\b/g },
];

/**
 * A Canadian SIN is validated with the Luhn algorithm. Checking it means we do not
 * redact every 9-digit number we happen to see.
 */
export function luhn(digits: string): boolean {
  if (digits.length !== 9) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let d = Number(digits[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Find PII in `text` and replace it with stable placeholders.
 *
 * `startIndex` lets a caller keep placeholder numbering unique across several
 * fields in the same run.
 */
export function detectPii(text: string, startIndex = 0): RedactionResult {
  const found: DetectedSpan[] = [];
  const taken: { start: number; end: number }[] = [];

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      const value = match[0];
      const start = match.index ?? 0;
      const end = start + value.length;
      if (taken.some((t) => start < t.end && end > t.start)) continue; // already claimed
      if (pattern.validate && !pattern.validate(value)) continue;
      taken.push({ start, end });
      found.push({ type: pattern.type, value, placeholder: '', start, end });
    }
  }

  found.sort((a, b) => a.start - b.start);
  found.forEach((span, i) => {
    span.placeholder = '[[PII_' + (startIndex + i + 1) + ']]';
  });

  // Replace back-to-front so earlier offsets stay valid.
  let redacted = text;
  for (const span of [...found].reverse()) {
    redacted = redacted.slice(0, span.start) + span.placeholder + redacted.slice(span.end);
  }

  return { redacted, spans: found };
}

/** Put the real values back. Only ever called on the local side of the boundary. */
export function rehydrate(text: string, spans: DetectedSpan[]): string {
  let out = text;
  for (const span of spans) out = out.split(span.placeholder).join(span.value);
  return out;
}

/** True if any placeholder survives — i.e. this payload is safe to send to a cloud model. */
export function containsPlaceholders(text: string): boolean {
  return /\[\[PII_\d+\]\]/.test(text);
}
