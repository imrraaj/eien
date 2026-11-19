/** Simple FIFO concurrency limiter. */
export function createLimiter(max: number) {
  const limit = Math.max(1, max);
  const queue: Array<() => void> = [];
  let active = 0;

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}
