/**
 * Run-level pause: a WAIT, not an interrupt.
 *
 * ============================================================================
 * THE MODEL. Pausing a run drains it: nothing NEW is allowed to start, but
 * whatever is already in flight — a model call, a tool call, an entire Hermes
 * agent_task — is left alone to finish on its own. This file is the one
 * primitive both halves are built from:
 *
 *   track(runId, fn)       wraps a unit of in-flight work. While any tracked
 *                          unit is running, the run cannot fully reach
 *                          'paused' — see requestPause().
 *   checkpoint(runId, sig) called right before a NEW unit of work would start.
 *                          Resolves immediately while the run is 'running';
 *                          otherwise blocks until resume() is called, or
 *                          rejects if the run is aborted while waiting.
 *
 * Callers (all in core/orchestrator.ts): `ctx.step`, `ctx.fanOut`'s parent and
 * each worker, and `ctx.runAgentTask` checkpoint before they create their
 * step, then track their own body. `ctx.requireApproval` is the one exception:
 * a human decision is not "work in flight" the drain should wait for (nothing
 * is running while a person reads an approval), so it explicitly `release()`s
 * before the wait and `reacquire()`s after — see that function for why this
 * still balances against the enclosing `track()`.
 *
 * WHY WAIT AND NEVER INTERRUPT AT A LOWER LEVEL. Two reasons, from Hermes
 * specifically:
 *
 *   1. Cutting a Hermes agent_task off mid-turn is not free: `cancelTask`
 *      disposes the ACP session, so there is no resuming that exact turn --
 *      only starting a new one with the transcript as context. Consistency
 *      with every other node (which also just finishes) was chosen over the
 *      lower, less predictable latency an interrupt would buy.
 *   2. The wait is already bounded. `runAgentTask`'s own inactivity/wall-clock/
 *      failed-tool-call budgets (playbooks/types.ts) apply exactly as they
 *      would if nobody had asked to pause, so "wait for it to finish" cannot
 *      hang a pause forever, only as long as that task was already allowed
 *      to run.
 *
 * NOT PERSISTED, ON PURPOSE. This is in-memory only, keyed by runId, with no
 * store or bus dependency -- same shape as core/approvalGate.ts's `waiters`
 * map, and for the same reason: a pause is meaningless once the process that
 * was driving the run is gone. An API restart cancels a paused run exactly as
 * it does a running one (see services/runs.service.ts's probeStaleRuns) --
 * resuming a paused run across a restart was explicitly ruled out of scope.
 * ============================================================================
 */

interface Gate {
  state: 'running' | 'pausing' | 'paused';
  /** Count of `track()` calls currently in flight for this run. */
  active: number;
  /** Woken by resume(); each entry is one blocked checkpoint() call. */
  resumeWaiters: (() => void)[];
  /** Set by requestPause() while draining; fired once by whichever of
   *  (a) active hits 0, or (b) resume() wins the race, happens first. */
  onDrained?: () => void;
}

const gates = new Map<string, Gate>();

function stateFor(runId: string): Gate {
  let gate = gates.get(runId);
  if (!gate) {
    gate = { state: 'running', active: 0, resumeWaiters: [] };
    gates.set(runId, gate);
  }
  return gate;
}

/** If draining and now idle, flip to 'paused' and resolve whoever is waiting on that. */
function checkDrained(gate: Gate): void {
  if (gate.state === 'pausing' && gate.active === 0) {
    gate.state = 'paused';
    const onDrained = gate.onDrained;
    gate.onDrained = undefined;
    onDrained?.();
  }
}

/**
 * Run `fn` as one unit of in-flight work: it counts against the drain this
 * run's pause is waiting on, for exactly as long as `fn` takes, regardless of
 * whether it succeeds or throws.
 */
export async function track<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const gate = stateFor(runId);
  gate.active += 1;
  try {
    return await fn();
  } finally {
    gate.active -= 1;
    checkDrained(gate);
  }
}

/**
 * Temporarily stop counting as in-flight work — for a span that is genuinely
 * idle (waiting on a human), not merely slow. Must be paired with exactly one
 * later `reacquire()`, from the same logical call, even on a rejected path.
 */
export function release(runId: string): void {
  const gate = stateFor(runId);
  gate.active = Math.max(0, gate.active - 1);
  checkDrained(gate);
}

/**
 * Undo a `release()`. Deliberately does NOT re-check `checkDrained` or demote
 * a fully 'paused' run back to 'pausing' — pause is a level the run sits at,
 * not an edge that fires once. If this reacquire happens while already
 * 'paused' (the release fully drained the run and nothing else was in
 * flight), the caller is expected to immediately await `checkpoint()`, which
 * blocks exactly as it would for any other new unit of work.
 */
export function reacquire(runId: string): void {
  stateFor(runId).active += 1;
}

/**
 * Block until this run is not paused or pausing. Resolves immediately when
 * running. Rejects if the signal aborts while waiting, so a cancelled run
 * does not hang here forever.
 */
export function checkpoint(runId: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Run aborted'));
  const gate = stateFor(runId);
  if (gate.state === 'running') return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const onResume = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      const at = gate.resumeWaiters.indexOf(onResume);
      if (at !== -1) gate.resumeWaiters.splice(at, 1);
      reject(new Error('Run aborted while paused'));
    };
    gate.resumeWaiters.push(onResume);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Ask this run to pause. Resolves once fully drained: every `track()`ed unit
 * that was already running has finished (or the run reports idle immediately,
 * if nothing was running).
 *
 * If a concurrent `resume()` wins the race — someone resumes before the drain
 * finishes — this still resolves, but the gate's state will read 'running',
 * not 'paused'. The caller (Orchestrator.pause) checks `stateOf()` after the
 * await and must NOT treat that as "now paused".
 */
export function requestPause(runId: string): Promise<void> {
  const gate = stateFor(runId);
  if (gate.state !== 'running') return Promise.resolve(); // already pausing or paused
  if (gate.active === 0) {
    gate.state = 'paused';
    return Promise.resolve();
  }
  gate.state = 'pausing';
  return new Promise<void>((resolve) => {
    gate.onDrained = resolve;
  });
}

/**
 * Resume: release every blocked `checkpoint()`, and settle a still-draining
 * `requestPause()` so it cannot hang forever (see that function's race note).
 * A no-op if the run was not paused or pausing.
 */
export function resume(runId: string): void {
  const gate = stateFor(runId);
  gate.state = 'running';

  const onDrained = gate.onDrained;
  gate.onDrained = undefined;
  onDrained?.();

  const waiters = gate.resumeWaiters;
  gate.resumeWaiters = [];
  for (const wake of waiters) wake();
}

export function stateOf(runId: string): 'running' | 'pausing' | 'paused' {
  return gates.get(runId)?.state ?? 'running';
}

/** Forget this run's gate. Call once it reaches a terminal status. */
export function dispose(runId: string): void {
  gates.delete(runId);
}
