/**
 * Small async primitives with the properties money-moving loops depend on.
 */

/**
 * Sleep that wakes on abort, clears its timer and removes its own listener.
 *
 * A strategy sleeps thousands of times in one run; a listener left on the
 * signal each time is a leak that only shows up in long-running processes.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || !(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * `ms`, varied by up to ±`spread` (a fraction), centred on `ms`.
 *
 * Never returns 0 for a positive interval: a jitter that can collapse to no
 * delay turns a polling loop into a busy loop against the RPC.
 */
export function jitter(ms: number, spread = 0.25, random: () => number = Math.random): number {
  if (!(ms > 0)) return ms;
  const swing = ms * Math.max(0, Math.min(1, spread));
  return Math.max(1, Math.round(ms + swing * (random() - 0.5) * 2));
}

/**
 * Serialises work per key. Two sends from one wallet must never interleave, or
 * they read the same pending nonce and one of them is lost.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Keys currently held or queued. For tests and diagnostics. */
  get size(): number {
    return this.tails.size;
  }
}

/**
 * Resolve keys concurrently in node-sized groups, then retry misses in smaller
 * groups. Robinhood Chain's public RPC rejects a JSON-RPC batch of 150 outright,
 * failing every call in it; 100 succeeds.
 *
 * A key whose read returns null (or throws) is absent from the result.
 */
export async function inBatches<K, V>(
  keys: readonly K[],
  read: (key: K) => Promise<V | null>,
  size = 100,
  retrySize = 20,
): Promise<Map<K, V>> {
  const out = new Map<K, V>();
  const pass = async (slice: readonly K[]): Promise<K[]> => {
    const settled = await Promise.all(slice.map((key) => read(key).catch(() => null)));
    const missed: K[] = [];
    settled.forEach((value, i) => {
      const key = slice[i] as K;
      if (value === null || value === undefined) missed.push(key);
      else out.set(key, value);
    });
    return missed;
  };
  for (let i = 0; i < keys.length; i += size) {
    const missed = await pass(keys.slice(i, i + size));
    for (let j = 0; j < missed.length; j += retrySize) {
      await pass(missed.slice(j, j + retrySize));
    }
  }
  return out;
}
