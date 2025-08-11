// agent-hub-brain/src/utils/retry.ts
export async function retry<T>(
  fn: () => Promise<T | null>,
  attempts = 6,
  delayMs = 800
): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fn();
      if (r) return r;
    } catch {}
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return null;
}