/**
 * The Jev browser decision — ONE System One request per browser step.
 *
 * ============================================================================
 * OWNERSHIP: written by Person 3 track 3B, which owns the browser's Jev call.
 * It sits in providers/jev/ because that is where Jev calls belong and because
 * only providers/ may do I/O — it deliberately does NOT modify Person 2's
 * index.ts or live.ts. When Person 2 takes Jev over, absorb it.
 *
 * WHAT JEV IS: TypeSafe AI's System One model (`jev-latest`). It answers TYPED
 * QUESTIONS AGAINST STATE and returns a choice, a score or a probability, each
 * with calibrated confidence. It cannot generate text. There is no prompt in
 * this file, and there must never be one — `criteria` is the interface.
 *
 * SPECULATIVE FAN-OUT, the whole trick:
 *
 *     one request ─┬─ operation         CLICK | TYPE_TEXT | SELECT | SCROLL...
 *                  ├─ click_target      choice over click-eligible indices
 *                  ├─ type_text_target  choice over editable indices
 *                  └─ select_target     choice over dropdown indices
 *
 * We ask for the operation AND every target it might need, then throw away the
 * heads that do not match the chosen operation. Two decisions, one round trip.
 *
 * That trade is deliberate and it is NOT free: the published browser benchmark
 * measured tasks 31-43% faster but inference cost 38-51% HIGHER, because you
 * pay for the discarded heads. It is the right trade here because latency on
 * stage is worth more than fractions of a cent, and because batching itself is
 * near-free — TypeSafe's own numbers put 13 batched questions at 11.5x cheaper
 * and 9.6x faster than 13 separate calls, with bit-identical answers. Drop
 * heads from `allowedOperations` if a run ever needs the cost back.
 *
 * TIMEOUTS — THE TRAP: the SDK defaults to 10000ms PER ATTEMPT with 2 retries
 * and 500ms-to-5000ms backoff, and there is explicitly NO TOTAL RETRY BUDGET.
 * Worst case is ~25s hanging one browser click. Those defaults are tuned for
 * background work. We override per call to ~2s / 1 retry and let the
 * deterministic fallback take the step instead of stalling the demo.
 *
 * NO DEPENDENCY IS ADDED BY THIS FILE. `@typesafe-ai/sdk` is imported
 * dynamically through a variable specifier, so the repo compiles, installs and
 * runs without it. With no package and no key this decider reports unavailable
 * and the caller uses the deterministic path. To go live:
 *     pnpm --filter @htn/api add @typesafe-ai/sdk     # dependency owner's call
 *     TYPESAFE_API_KEY=... in the root .env
 * Nothing else changes.
 * ============================================================================
 */

import type { BrowserOperation } from '@htn/shared';
import type {
  BrowserDecider,
  BrowserDecision,
  BrowserDecisionRequest,
} from '../../core/tools/browserDecision.js';
import { eligibleRows, toCriteria, toState } from '../../core/tools/elementTable.js';
import { config } from '../../config.js';

/** The npm package, as a variable so tsc does not try to resolve it. */
const SDK_SPECIFIER = '@typesafe-ai/sdk';

/**
 * Minimal structural view of the SDK. We type what we use rather than importing
 * vendor types — the standing rule is that vendor SDK types never escape a
 * provider file, and here they do not even enter one.
 */
interface SystemOneAnswer {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface SystemOneResponse {
  answers: Record<string, SystemOneAnswer>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface SystemOneClient {
  systemOne(
    request: { state: unknown; questions: Record<string, unknown>; model?: string },
    options?: { timeout?: number; retry?: { maxRetries?: number }; signal?: AbortSignal },
  ): Promise<SystemOneResponse>;
}

interface Sdk {
  TypeSafeClient: new (config?: Record<string, unknown>) => SystemOneClient;
  choice: (instructions: string, criteria: Record<string, string | null>) => unknown;
}

let sdkPromise: Promise<Sdk | null> | undefined;

/** Loaded once. A missing package is a normal state, not an error. */
function loadSdk(): Promise<Sdk | null> {
  sdkPromise ??= import(SDK_SPECIFIER)
    .then((mod) => mod as Sdk)
    .catch(() => {
      console.warn(
        '[jev] ' +
          SDK_SPECIFIER +
          ' is not installed; browser decisions use the deterministic fallback.',
      );
      return null;
    });
  return sdkPromise;
}

export interface JevBrowserDeciderOptions {
  /** Per-attempt budget. Default: BROWSER_DECISION_TIMEOUT_MS (2000ms). */
  timeoutMs?: number;
  /** Default 1. The SDK's 2 is too many for an interactive step. */
  maxRetries?: number;
}

/**
 * Build the Jev decider. Returns `null` when Jev cannot be reached at all — no
 * key or no package — so the caller can label the run's decision source
 * truthfully instead of silently pretending a fallback was a model call.
 */
export async function createJevBrowserDecider(
  options: JevBrowserDeciderOptions = {},
): Promise<BrowserDecider | null> {
  if (!config.typesafe.apiKey) return null;

  const sdk = await loadSdk();
  if (!sdk) return null;

  const client = new sdk.TypeSafeClient({
    apiKey: config.typesafe.apiKey,
    defaultModel: config.typesafe.defaultModel,
    // NEVER dangerouslyAllowBrowser. This is server-side only; enabling it
    // would put the key in a page.
  });

  const timeout = options.timeoutMs ?? config.browser.decisionTimeoutMs;
  const maxRetries = options.maxRetries ?? 1;

  return async (request: BrowserDecisionRequest): Promise<BrowserDecision> => {
    const { table, goal, allowedOperations, signal } = request;

    const allowed = (op: BrowserOperation): boolean =>
      !allowedOperations || allowedOperations.includes(op);

    /* -- Build the operation head. Only offer operations that are possible. - */
    const clickRows = allowed('CLICK') ? eligibleRows(table, 'CLICK') : [];
    const typeRows = allowed('TYPE_TEXT') ? eligibleRows(table, 'TYPE_TEXT') : [];
    const selectRows = allowed('SELECT') ? eligibleRows(table, 'SELECT') : [];

    const operationCriteria: Record<string, string> = {};
    if (clickRows.length > 0) operationCriteria.CLICK = 'Click one of the listed elements.';
    if (typeRows.length > 0) {
      // The label says so on purpose: this is the rule people get wrong.
      operationCriteria.TYPE_TEXT =
        'Type into one of the listed fields. A separate model supplies the text.';
    }
    if (selectRows.length > 0) operationCriteria.SELECT = 'Choose an option in a dropdown.';
    if (allowed('SCROLL_DOWN')) operationCriteria.SCROLL_DOWN = 'Scroll down to reveal more.';
    if (allowed('SCROLL_UP')) operationCriteria.SCROLL_UP = 'Scroll back up.';
    if (allowed('WAIT')) operationCriteria.WAIT = 'Wait for the page to settle.';
    if (allowed('DONE')) operationCriteria.DONE = 'The goal is already satisfied on this page.';
    if (allowed('BLOCKED')) {
      operationCriteria.BLOCKED = 'The goal cannot be progressed from this page.';
    }

    // A choice question needs at least two options to be a question at all.
    if (Object.keys(operationCriteria).length < 2) {
      return {
        operation: 'BLOCKED',
        confidence: 0.2,
        source: 'jev',
        rationale: 'No operation was possible on this page, so Jev was not asked.',
      };
    }

    /* -- Speculative target heads, all in the SAME request. ---------------- */
    const questions: Record<string, unknown> = {
      operation: sdk.choice('What is the single best next action for the goal?', operationCriteria),
    };

    const clickCriteria = toCriteria(clickRows);
    if (clickCriteria && Object.keys(clickCriteria).length > 1) {
      questions.click_target = sdk.choice('Which element should be clicked?', clickCriteria);
    }
    const typeCriteria = toCriteria(typeRows);
    if (typeCriteria && Object.keys(typeCriteria).length > 1) {
      questions.type_text_target = sdk.choice('Which field should be typed into?', typeCriteria);
    }
    const selectCriteria = toCriteria(selectRows);
    if (selectCriteria && Object.keys(selectCriteria).length > 1) {
      questions.select_target = sdk.choice('Which dropdown should be used?', selectCriteria);
    }

    const response = await client.systemOne(
      { state: toState(table, goal), questions },
      { timeout, retry: { maxRetries }, ...(signal ? { signal } : {}) },
    );

    /* -- Use the matching head; discard the rest. -------------------------- */
    const opAnswer = response.answers.operation;
    const operation = (opAnswer?.choice ?? 'BLOCKED') as BrowserOperation;

    const targetAnswer =
      operation === 'CLICK'
        ? response.answers.click_target
        : operation === 'TYPE_TEXT'
          ? response.answers.type_text_target
          : operation === 'SELECT'
            ? response.answers.select_target
            : undefined;

    // A single-eligible-row head is not asked (a one-option choice is not a
    // question), so fall back to that row rather than failing the step.
    const soleRow =
      operation === 'CLICK'
        ? clickRows[0]
        : operation === 'TYPE_TEXT'
          ? typeRows[0]
          : operation === 'SELECT'
            ? selectRows[0]
            : undefined;

    const index = targetAnswer?.choice !== undefined ? Number(targetAnswer.choice) : soleRow?.index;

    // The combined confidence is the weaker of the two decisions. Reporting the
    // operation's confidence alone would hide a coin-flip between two buttons,
    // which is precisely the case the escalation rule exists for.
    const confidence = Math.min(opAnswer?.confidence ?? 0, targetAnswer?.confidence ?? 1);

    return {
      operation,
      ...(index !== undefined && Number.isFinite(index) ? { index } : {}),
      confidence,
      ...(targetAnswer?.probabilities ? { probabilities: targetAnswer.probabilities } : {}),
      source: 'jev',
      rationale:
        'Jev chose ' +
        operation +
        (index !== undefined ? ' on [' + index + ']' : '') +
        ' (confidence ' +
        confidence.toFixed(2) +
        ').',
    };
  };
}
