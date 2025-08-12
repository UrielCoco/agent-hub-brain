// /api/_lib/assistant.ts
import OpenAI from 'openai';
import type { Redis } from '@upstash/redis';

// ===== OpenAI =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID!;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===== Redis (opcional) =====
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
let useRedis = Boolean(REDIS_URL && REDIS_TOKEN);
let redis: InstanceType<typeof Redis> | null = null;

async function ensureRedis() {
  if (!useRedis || redis) return;
  const { Redis } = await import('@upstash/redis');
  redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) as any;
}

// ===== Fallback memoria =====
const mem = new Map<string, { value: string; exp: number }>();
const MEM_TTL = 60 * 60 * 24 * 30 * 1000; // 30 días

async function kvGet(key: string): Promise<string | null> {
  if (useRedis) {
    try {
      await ensureRedis();
      return (await (redis as any).get<string>(key)) ?? null;
    } catch {
      useRedis = false;
    }
  }
  const rec = mem.get(key);
  if (!rec) return null;
  if (Date.now() > rec.exp) {
    mem.delete(key);
    return null;
  }
  return rec.value;
}

async function kvSet(key: string, val: string) {
  if (useRedis) {
    try {
      await ensureRedis();
      await (redis as any).set(key, val, { ex: 60 * 60 * 24 * 30 }); // 30 días
      return;
    } catch {
      useRedis = false;
    }
  }
  mem.set(key, { value: val, exp: Date.now() + MEM_TTL });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function sendToAssistant(sessionId: string, userText: string) {
  if (!OPENAI_ASSISTANT_ID) throw new Error('Falta OPENAI_ASSISTANT_ID');

  // 1) Recupera/crea thread
  const key = `thread:${sessionId}`;
  let threadId = await kvGet(key);
  if (!threadId) {
    const thr = await openai.beta.threads.create();
    threadId = thr.id;
    await kvSet(key, threadId);
  }

  // 2) Añade mensaje de usuario
  await openai.beta.threads.messages.create(threadId, {
    role: 'user',
    content: userText,
  });

  // 3) Ejecuta el assistant
  const run = await openai.beta.threads.runs.create(threadId, {
    assistant_id: OPENAI_ASSISTANT_ID,
  });

  // 4) Polling simple
  let status = run.status;
  while (status === 'queued' || status === 'in_progress') {
    await sleep(600);
    const r = await openai.beta.threads.runs.retrieve(threadId, run.id);
    status = r.status;
    if (status === 'requires_action') throw new Error('Assistant requiere tools no implementadas');
    if (['failed', 'cancelled', 'expired'].includes(status)) throw new Error(`Run ${status}`);
  }

  // 5) Último mensaje del assistant
  const msgs = await openai.beta.threads.messages.list(threadId, { limit: 10 });
  const last = msgs.data.find((m: any) => m.role === 'assistant');
  const text =
    (last?.content?.[0] as any)?.text?.value ??
    (Array.isArray(last?.content)
      ? last!.content.map((c: any) => c?.text?.value).filter(Boolean).join('\n')
      : '...');

  return { text, threadId };
}
