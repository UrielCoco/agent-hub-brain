import { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } from "../config.js";

const mem = new Map<string, string>(); // sessionId -> threadId

export async function getThreadId(sessionId: string): Promise<string | null> {
  if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
    const res = await fetch(`${UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      return data?.result || null;
    }
  }
  return mem.get(sessionId) || null;
}

export async function setThreadId(sessionId: string, threadId: string): Promise<void> {
  if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
    await fetch(`${UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(sessionId)}/${encodeURIComponent(threadId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
    });
  }
  mem.set(sessionId, threadId);
}
