/**
 * The "small LLM → text → browser" box in the jev-ultrafast diagram.
 *
 * ============================================================================
 * THE DIVISION OF LABOUR THIS FILE EXISTS TO ENFORCE:
 *
 *     Jev  ──► WHICH FIELD   (a choice: an index into our element table)
 *     LLM  ──► WHAT TO TYPE  (generated text)
 *
 * Jev cannot generate text. It returns a key from a `criteria` set and nothing
 * else. So a TYPE_TEXT decision is only half an instruction — something has to
 * supply the value, and that something is a small generative model.
 *
 * WHY "SMALL": the task is "given the goal and the field's label, produce the
 * literal string to type". That is a cheap-tier job, so it asks for the CHEAP
 * tier explicitly rather than inheriting whatever the run is using.
 *
 * WHY IT GOES THROUGH A CAPABILITY, not a vendor: `text.model` is whatever the
 * registry binds it to. That keeps this file swappable and keeps vendor SDK
 * types out of core, which is the repo's standing rule.
 *
 * FAIL SOFT, NOT CLOSED. If no model is available, this returns the caller's
 * fallback rather than throwing. Typing is not a permission decision — the gate
 * has already run by the time we get here — so a missing model should degrade
 * the text, not kill the step. It reports which happened so the trace can say
 * so truthfully.
 * ============================================================================
 */

import type { ProviderCallContext, TextModelAdapter } from '@htn/shared';

export interface ComposedText {
  text: string;
  /** Truthful labeling: did a model actually write this? */
  source: 'model' | 'fallback';
}

export type ComposeText = (input: {
  /** What the step is trying to achieve. */
  goal: string;
  /** The label of the field Jev chose, so the model knows what is being asked for. */
  fieldLabel: string;
  /** Used when no model is available. Usually the caller's own value. */
  fallback: string;
  signal?: AbortSignal;
}) => Promise<ComposedText>;

/**
 * Strip the things a chat model adds that a form field must not receive.
 *
 * A model told to "return only the value" will still sometimes wrap it in
 * quotes, prefix it with `Query:`, or add a trailing period. Typing any of
 * those into a search box changes the search.
 */
export function cleanTypedValue(raw: string): string {
  let value = raw.trim().split('\n')[0]?.trim() ?? '';
  value = value.replace(/^(?:query|search|answer|value|text)\s*[:=]\s*/i, '');
  // Matching quote pairs only — an apostrophe inside a name is not a quote.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('`') && value.endsWith('`'))
  ) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

export interface ComposeTextOptions {
  /** `null` when no text model is bound, or when it is only a mock. */
  model: TextModelAdapter | null;
  callContext: (args: { policyRule: string }) => ProviderCallContext;
  /** Hard cap. A form value is short; anything long is a model going astray. */
  maxChars?: number;
}

export function createComposeText(options: ComposeTextOptions): ComposeText {
  const maxChars = options.maxChars ?? 200;

  return async ({ goal, fieldLabel, fallback, signal }) => {
    if (!options.model) return { text: fallback, source: 'fallback' };

    try {
      const result = await options.model.complete(
        {
          system:
            'You fill in one form field. Reply with ONLY the exact literal value to type. ' +
            'No quotes, no label, no explanation, no trailing punctuation.',
          prompt:
            'Goal: ' +
            goal +
            '\nField: ' +
            (fieldLabel || '(unlabelled input)') +
            '\nValue to type:',
          maxTokens: 64,
          // Cheap tier on purpose — see this file's header.
          tier: 'cheap',
        },
        {
          ...options.callContext({ policyRule: 'compose-field-value' }),
          ...(signal ? { signal } : {}),
        },
      );

      if (!result.ok) return { text: fallback, source: 'fallback' };

      const value = cleanTypedValue(result.data.text).slice(0, maxChars);
      // An empty or absurd answer is worse than the caller's own value.
      return value.length > 0
        ? { text: value, source: 'model' }
        : { text: fallback, source: 'fallback' };
    } catch {
      return { text: fallback, source: 'fallback' };
    }
  };
}
