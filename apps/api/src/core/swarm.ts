/**
 * Bounded-concurrency fan-out.
 *
 * The swarm needs no entity of its own: a fan-out is N steps sharing a
 * parentStepId, and the judge is a sibling step whose input references them.
 * That is why this file is 40 lines and not a subsystem.
 */

export interface FanOutOptions {
  /** Max workers in flight. Keep this honest — it is bounded by provider rate limits. */
  concurrency?: number;
  signal?: AbortSignal;
}

export interface FanOutOutcome<O> {
  index: number;
  ok: boolean;
  value?: O;
  error?: Error;
}

/**
 * Runs `worker` over `items` with bounded concurrency.
 *
 * One worker failing does NOT abort the others — a swarm's value is independent
 * evidence, so a partial result set is still useful to the judge. Inspect `ok`.
 */
export async function fanOut<I, O>(
  items: I[],
  worker: (item: I, index: number) => Promise<O>,
  opts: FanOutOptions = {},
): Promise<FanOutOutcome<O>[]> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, items.length || 1));
  const results: FanOutOutcome<O>[] = new Array(items.length);
  let cursor = 0;

  async function pump(): Promise<void> {
    for (;;) {
      if (opts.signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { index, ok: true, value: await worker(items[index] as I, index) };
      } catch (err) {
        results[index] = { index, ok: false, error: err as Error };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, pump));
  return results;
}

/** Convenience: the values of the workers that succeeded. */
export function successes<O>(outcomes: FanOutOutcome<O>[]): O[] {
  return outcomes.filter((o) => o.ok).map((o) => o.value as O);
}
