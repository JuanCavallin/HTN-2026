import type { BrowserAdapter, ProviderCallContext } from '@htn/shared';

type Owner = 'agent' | 'human';
interface SessionOwner {
  runId: string;
  owner: Owner;
}

/** Server-side run ownership and serialization for every browser backend. */
export function withBrowserOwnership(adapter: BrowserAdapter): BrowserAdapter {
  const sessions = new Map<string, SessionOwner>();
  const tails = new Map<string, Promise<void>>();

  async function serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    tails.set(id, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (tails.get(id) === tail) tails.delete(id);
    }
  }

  function check(
    id: string,
    ctx: ProviderCallContext,
    access: 'agent' | 'human' | 'cleanup' = 'agent',
  ): void {
    const session = sessions.get(id);
    if (!session || session.runId !== ctx.runId)
      throw new Error('Browser session is not owned by this run.');
    if (access === 'human' && session.owner !== 'human')
      throw new Error('Browser session is not currently handed to a person.');
    if (access === 'agent' && session.owner === 'human')
      throw new Error('Browser session is under human control.');
  }

  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'setOwnership')
        return async (input: { sessionId: string; owner: Owner }, ctx: ProviderCallContext) => {
          const owned = sessions.get(input.sessionId);
          if (!owned || owned.runId !== ctx.runId)
            throw new Error('Browser session is not owned by this run.');
          // Flip access before waiting for an in-flight browser call to settle.
          owned.owner = input.owner;
          await serialized(input.sessionId, async () => undefined);
        };
      if (prop === 'releaseRun')
        return async (runId: string, ctx: ProviderCallContext) => {
          if (runId !== ctx.runId)
            throw new Error('Cannot release browser resources for another run.');
          const entries = [...sessions].filter(([, value]) => value.runId === runId);
          await Promise.all(
            entries.map(([id]) =>
              serialized(id, async () => {
                const result = await target.closeSession(id, ctx);
                if (!result.ok) throw new Error(result.error.message);
                sessions.delete(id);
              }),
            ),
          );
        };
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (
        typeof value !== 'function' ||
        ![
          'openSession',
          'act',
          'extract',
          'closeSession',
          'liveView',
          'snapshot',
          'perform',
        ].includes(String(prop))
      )
        return value;
      return async (...args: unknown[]) => {
        const ctx = args.at(-1) as ProviderCallContext;
        const first = args[0] as { sessionId?: string } | string | undefined;
        if (prop === 'openSession') {
          const result = (await (value as (...a: unknown[]) => Promise<unknown>).apply(
            target,
            args,
          )) as { ok?: boolean; data?: { sessionId?: string } };
          if (result.ok && result.data?.sessionId)
            sessions.set(result.data.sessionId, { runId: ctx.runId, owner: 'agent' });
          return result;
        }
        const id = typeof first === 'string' ? first : first?.sessionId;
        if (!id) throw new Error('Browser operation requires a session id.');
        const cleanup = prop === 'closeSession' && ctx.policyRule.includes('release');
        const access = cleanup ? 'cleanup' : prop === 'liveView' ? 'human' : 'agent';
        check(id, ctx, access);
        return serialized(id, async () => {
          // Ownership may have changed while this call queued.
          check(id, ctx, access);
          const result = (await (value as (...a: unknown[]) => Promise<unknown>).apply(
            target,
            args,
          )) as { ok?: boolean };
          if (prop === 'closeSession' && result.ok) sessions.delete(id);
          return result;
        });
      };
    },
  });
}
