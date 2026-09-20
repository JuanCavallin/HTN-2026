/**
 * Outbound-text check — the policy half of the `content.analysis` capability.
 *
 * ============================================================================
 * THE INVARIANT THIS FILE EXISTS TO ENFORCE: IT MAY ONLY ESCALATE.
 *
 * A content score is a SIGNAL, not an authorization. It can move a policy
 * toward the human (auto -> verify -> ask_user) and never away from one. There
 * is deliberately no code path here that returns a weaker policy than it was
 * given, no path that turns 'deny' into anything, and no path that marks an
 * unauthorized action allowed. If you are adding one, you are removing the gate.
 *
 * Why that direction specifically: GPTZero answers "does this read as machine
 * written", which is evidence about the TEXT. Whether the action is permitted
 * is a question about the DESTINATION, the data labels and the user's intent,
 * and those were already decided by authorizeAction upstream. A text score can
 * add a reason to pause. It can never supply a reason to proceed.
 * ---------------------------------------------------------------------------
 * FAIL OPEN, ON PURPOSE — and this is the one place in the broker that does.
 *
 * Everything else in broker.ts fails closed. This does not, because the failure
 * modes are not symmetric:
 *
 *   - Failing closed here means a GPTZero outage, a rate limit or a missing key
 *     blocks every outbound email the agent was ALREADY authorized to send.
 *     The check is advisory, so that is an outage in an advisory component
 *     taking down a permitted action.
 *   - Failing open means we lose one advisory signal on a send that authorization,
 *     data labels, destination binding and (for irreversible actions) a human
 *     approval have all already passed.
 *
 * So a provider error leaves the upstream policy exactly as it was and records
 * `unavailable` in the trace. The trace never claims the text was checked when
 * it was not — that is what keeps "fail open" honest rather than silent.
 * ============================================================================
 */

import type {
  ActionPolicy,
  ContentAnalysisAdapter,
  ProviderCallContext,
  ToolAction,
  ToolDescriptor,
} from '@htn/shared';

/**
 * Argument fields that carry prose written in the user's name.
 *
 * An allowlist, not a scan of every string: `to`, `subject` and `url` are not
 * prose, and scoring them would spend a call to score a header. Keyed by the
 * AgentOS tool id so a provider renaming its own field cannot silently change
 * what gets checked.
 *
 * Browser typing is listed per provider because the descriptor ids are built as
 * `<providerId>.<operation>` (browserDescriptors.ts), so there is no single
 * `browser.type`. `goal` is excluded on purpose: it is the agent's own
 * instruction to itself, not text the user is about to be seen writing.
 */
const OUTBOUND_TEXT_FIELDS: Record<string, readonly string[]> = {
  'mail.send': ['body'],
  'localbrowser.type': ['text'],
  'browserbase.type': ['text'],
};

/** Above this P(ai), a send that would have gone through unattended stops for a human. */
export const DEFAULT_AI_ESCALATION_THRESHOLD = 0.75;

export type ContentCheckOutcome = 'skipped' | 'unavailable' | 'passed' | 'escalated';

export interface ContentCheckResult {
  outcome: ContentCheckOutcome;
  /** The policy to proceed with. Never weaker than the one passed in. */
  policy: ActionPolicy;
  /** P(ai) in 0..1, when a score was actually obtained. */
  score?: number;
  label?: string;
  /** Appended to the authorization's reason codes so the trace explains itself. */
  reasonCodes: string[];
}

export interface ContentCheckOptions {
  threshold?: number;
  /** Text shorter than this is not worth a network call. */
  minChars?: number;
}

/** Ordered weakest -> strongest. Escalation is a move rightward in this list. */
const POLICY_RANK: Record<ActionPolicy, number> = {
  auto: 0,
  verify: 1,
  ask_user: 2,
  deny: 3,
};

/** Returns whichever policy is stricter. The only way this file changes a policy. */
function strictest(a: ActionPolicy, b: ActionPolicy): ActionPolicy {
  return POLICY_RANK[b] > POLICY_RANK[a] ? b : a;
}

/** Pull the prose fields this tool is known to send, in declaration order. */
export function outboundTextOf(action: ToolAction): string {
  const fields = OUTBOUND_TEXT_FIELDS[action.toolId];
  if (!fields) return '';
  const args = action.arguments as Record<string, unknown> | null;
  if (typeof args !== 'object' || args === null) return '';

  return fields
    .map((field) => args[field])
    .filter((value): value is string => typeof value === 'string')
    .join('\n\n')
    .trim();
}

/**
 * Score the text this action would send and return the policy to proceed with.
 *
 * `currentPolicy` is the authorization's final policy. The returned policy is
 * `currentPolicy` or stricter — see the invariant at the top of this file.
 *
 * NOT RE-RUN ON A HUMAN REVISION, deliberately. The broker reauthorizes revised
 * arguments, but it does not re-score them: the question this check asks is
 * "did a machine write this", and on the revision path a human demonstrably
 * did. Re-scoring would also risk escalating to `ask_user` the payload the same
 * person just wrote, which the broker documents as a loop rather than a gate.
 */
export async function checkOutboundText(
  analysis: ContentAnalysisAdapter,
  action: ToolAction,
  descriptor: ToolDescriptor,
  currentPolicy: ActionPolicy,
  ctx: ProviderCallContext,
  options: ContentCheckOptions = {},
): Promise<ContentCheckResult> {
  const threshold = options.threshold ?? DEFAULT_AI_ESCALATION_THRESHOLD;
  const minChars = options.minChars ?? 32;

  // A denied action is already at the strongest policy; scoring text we will
  // never send is a wasted call.
  if (currentPolicy === 'deny') {
    return { outcome: 'skipped', policy: currentPolicy, reasonCodes: [] };
  }

  // Only genuinely outbound tools carry text worth checking. A read does not
  // write anything in the user's name.
  if (descriptor.baselineEffect === 'read') {
    return { outcome: 'skipped', policy: currentPolicy, reasonCodes: [] };
  }

  const text = outboundTextOf(action);
  if (text.length < minChars) {
    return { outcome: 'skipped', policy: currentPolicy, reasonCodes: [] };
  }

  const result = await analysis.analyze(
    { text },
    { ...ctx, policyRule: 'outbound-text-authenticity-check' },
  );

  if (!result.ok) {
    // See the fail-open note at the top. The policy is untouched and the trace
    // says the check did not run, rather than implying the text passed.
    return {
      outcome: 'unavailable',
      policy: currentPolicy,
      reasonCodes: ['content_check_unavailable'],
    };
  }

  const { score, label } = result.data;
  if (score < threshold) {
    return {
      outcome: 'passed',
      policy: currentPolicy,
      score,
      label,
      reasonCodes: ['content_check_passed'],
    };
  }

  return {
    outcome: 'escalated',
    policy: strictest(currentPolicy, 'ask_user'),
    score,
    label,
    reasonCodes: ['outbound_text_reads_machine_written'],
  };
}
