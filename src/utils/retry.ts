// src/utils/retry.ts
export async function retry<T>(
  fn: () => Promise<T | null>,
  attempts = 5,
  delayMs = 800
): Promise<T | null> {
  let last: T | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fn();
      if (r) return r;
      await new Promise(res => setTimeout(res, delayMs));
    } catch {
      await new Promise(res => setTimeout(res, delayMs));
    }
  }
  return last;
}