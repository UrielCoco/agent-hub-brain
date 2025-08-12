// api/_lib/assistant.ts
// Persistencia de hilos con Upstash Redis (si está configurado),
// y fallback a memoria si no hay Redis. Compatible con Serverless Functions (Vercel).

import OpenAI from 'openai';

// ====== ENV REQUIRED ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID!;

// ====== OPTIONAL: Upstash Redis ======
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

let useRedis = Boolean(REDIS_URL && REDIS_TOKEN);

// Importamos de forma lazy para evitar fallos si no está instalado
type RedisClient = {
  get: <T = string>(key: string) => Promise<T | null>;
  set: (key: string, value: string, opts?: { ex?: number }) => Promise<any>;
};

let redis: RedisClient | null = null;

// ====== OpenAI client ======
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ====== Fallback en memoria ======
const mem = new Map<string, string>();
const MEM_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 días (best-effort)
const memTTL = new Map<string, number>();

function memGet(key: string): string | null {
  const exp = memTTL.get(key);
  if (exp && Date.now() > exp) {
    mem.delete(key);
    memTTL.delete(key);
    return null;
  }
  return mem.get(key) || null;
}
function memSet(key: string, val: string) {
  mem.set(key, val);
  memTTL.set(key, Date.now() + MEM_TTL_MS);
}

async function ensureRedis(): Promise<void> {
  if (!useRedis || redis) return;
  // Hacemos import dinámico para no romper el build si no está
  const { Redis } = await import('@upstash/redis');
  redis = new Redis({
    url: REDIS_URL,
    token: REDIS_TOKEN,
  }) as unknown as RedisClient;
}

// ========== KV helpers (auto-select Redis/Mem) ==========
async function kvGetThread(sessionId: string): Promise<string | null> {
  if (useRedis) {
    try {
      await ensureRedis();
      const val = await redis!.get<string>(`thread:${sessionId}`);
      return val ?? null;
    } catch (e) {
      // Si Redis falla, hacemos fallback
      useRedis = false;
    }
  }
  return memGet(`thread:${sessionId}`);
}

async function kvSetThread(sessionId: string, threadId: string): Promise<void> {
  if (useRedis) {
    try {
      await ensureRedis();
      await redis!.set(`thread:${sessionId}`, threadId, { ex: 60 * 60 * 24 * 30 }); // 30 días
      return;
    } catch (e) {
      useRedis = false;
    }
  }
  memSet(`thread:${sessionId}`, threadId);
}

// ========== Util ==========
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ========== API principal ==========
export async function sendToAssistant(sessionId: string, userText: string) {
  if (!OPENAI_ASSISTANT_ID) {
    throw new Error('Falta OPENAI_ASSISTANT_ID');
  }

  // 1) Resuelve/crea thread para la sesión
  let threadId = await kvGetThread(sessionId);
  if (!threadId) {
    const thr = await openai.beta.threads.create();
    threadId = thr.id;
    await kvSetThread(sessionId, threadId);
  }

  // 2) Añade mensaje del usuario
  await openai.beta.threads.messages.create(threadId, {
    role: 'user',
    content: userText,
  });

  // 3) Crea run con tu assistant
  const run = await openai.beta.threads.runs.create(threadId, {
    assistant_id: OPENAI_ASSISTANT_ID,
  });

  // 4) Poll simple hasta que termine
  let status = run.status;
  while (status === 'queued' || status === 'in_progress') {
    await sleep(600);
    const r = await openai.beta.threads.runs.retrieve(threadId, run.id);
    status = r.status;

    if (status === 'requires_action') {
      // Aquí podrías implementar tool-calls si los usas
      throw new Error('Assistant requiere tools no implementadas');
    }
    if (['failed', 'cancelled', 'expired'].includes(status)) {
      throw new Error(`Run ${status}`);
    }
  }

  // 5) Toma el último mensaje del assistant
  const msgs = await openai.beta.threads.messages.list(threadId, { limit: 10 });
  const last = msgs.data.find((m: any) => m.role === 'assistant');
  const text =
    (last?.content?.[0] as any)?.text?.value ??
    (Array.isArray(last?.content)
      ? last!.content
          .map((c: any) => c?.text?.value)
          .filter(Boolean)
          .join('\n')
      : '...');

  return { text, threadId };
}
