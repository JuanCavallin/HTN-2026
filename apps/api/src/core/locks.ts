/** FIFO ownership for mutable transcripts/resources. Rejected writers do not poison the queue. */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();
  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    const release = () => {
      unlock();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
    if (signal?.aborted) {
      release();
      throw new Error('Cancelled while waiting for ownership.');
    }
    return release;
  }
}
