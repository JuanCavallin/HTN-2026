/**
 * TEMPORARY mock of Jev's route() decision — for testing the Hermes/ACP
 * connection in isolation while a teammate builds the real thing.
 *
 * Does NOT import, touch, or depend on anything under
 * apps/api/src/providers/jev/** or packages/shared. Zero conflict risk with
 * that work. Delete this file once the real integration wires through the
 * actual Jev provider instead.
 *
 * Shape matches DecisionAdapter.route()'s real return type exactly
 * (packages/shared/src/providers.ts: { modelTier, exposedTools, confidence,
 * rationale }) — swapping this mock out later for the real call is a
 * one-line change in server.mjs, not a rewrite.
 */

/** Stand-in for the real ~50-tool registry (Person 3's work, not built yet). */
const PRESET_TOOLS = [
  'browser.navigate',
  'browser.extract',
  'forms.submit',
  'mail.send',
  'sheets.append',
  'calendar.create',
  'notify.slack',
  'notify.sms',
];

/**
 * @param {string} task
 * @returns {{ modelTier: string, exposedTools: string[], confidence: number, rationale: string }}
 */
export function mockJevRoute(task) {
  return {
    modelTier: 'standard',
    // Pretend Jev narrowed 8 candidates down to 3 — mirrors the real mock's
    // behavior in apps/api/src/providers/jev/index.ts (deterministic slice,
    // not random, so repeated test runs look the same).
    exposedTools: PRESET_TOOLS.slice(0, 3),
    confidence: 1,
    rationale:
      'MOCK — Jev bypassed for Hermes-only connectivity testing (task: "' + task + '"). Not a real decision.',
  };
}
