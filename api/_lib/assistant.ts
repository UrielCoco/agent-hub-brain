// agent-hub-brain-main-2/api/_lib/assistant.ts
// Mantiene sendToAssistant (OpenAI Assistants con Threads) y añade getAssistantReply
// para integrar con TU otro proyecto (ASSISTANT_BASE_URL).

import OpenAI from 'openai';
import type { Redis } from '@upstash/redis';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID!;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===== Redis (opcional para persistir thread) =====
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
let useRedis = Boolean(REDIS_URL && REDIS_TOKEN);
let redis: InstanceType<typeof Redis> | null = null;

async function ensureRedis() {
  if (!useRedis) return;
  if (redis) return;
  const mod = await import('@upstash/redis');
  redis = new mod.Redis({ url: REDIS_URL, token: REDIS_TOKEN }) as any;
}
async function kvGet(key: string) {
  if (!useRedis) return null;
  await ensureRedis();
  return await (redis as any).get(key);
}
async function kvSet(key: string, value: string) {
  if (!useRedis) return;
  await ensureRedis();
  await (redis as any).set(key, value);
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ====== Threads API “sendToAssistant” (ya lo tenías) ======
export async function sendToAssistant(sessionId: string, userText: string) {
  if (!OPENAI_ASSISTANT_ID) throw new Error('Falta OPENAI_ASSISTANT_ID');

  const key = `thread:${sessionId}`;
  let threadId = await kvGet(key);
  if (!threadId) {
    const thr = await openai.beta.threads.create();
    threadId = thr.id;
    await kvSet(key, threadId);
  }

  await openai.beta.threads.messages.create(threadId, { role: 'user', content: userText });
  const run = await openai.beta.threads.runs.create(threadId, { assistant_id: OPENAI_ASSISTANT_ID });

  // Polling simple
  let status = run.status;
  for (let i = 0; i < 40; i++) {
    await sleep(600);
    const cur = await openai.beta.threads.runs.retrieve(threadId, run.id);
    status = cur.status;
    if (status === 'completed') break;
    if (['failed', 'cancelled', 'expired'].includes(status)) throw new Error(`Run ${status}`);
  }

  const msgs = await openai.beta.threads.messages.list(threadId, { limit: 10 });
  const last = msgs.data.find((m: any) => m.role === 'assistant');
  const text =
    (last?.content?.[0] as any)?.text?.value ??
    (Array.isArray(last?.content)
      ? last!.content.map((c: any) => c?.text?.value).filter(Boolean).join('\n')
      : '...');

  return { text, threadId };
}

// ====== NUEVO: getAssistantReply para llamarle a tu OTRO proyecto ======
export async function getAssistantReply(userMsg: string, ctx: any = {}): Promise<string> {
  const base = process.env.ASSISTANT_BASE_URL;  // <- URL pública de tu otro proyecto (coco-volare)
  const key  = process.env.ASSISTANT_API_KEY || ""; // <- si lo proteges con bearer

  if (base) {
    const url = `${base.replace(/\/+$/,"")}/api/reply`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ message: userMsg, context: ctx }),
    });
    if (!r.ok) {
      const t = await r.text().catch(()=>"");
      throw new Error(`Assistant backend HTTP ${r.status}: ${t}`);
    }
    const j = await r.json().catch(()=> ({} as any));
    const reply = j?.reply ?? j?.text ?? j?.answer ?? "";
    return String(reply || "Listo ✅");
  }

  // Fallback: usa Threads API local con sesión por lead/contact
  const sessionId =
    ctx?.leadId ? `kommo:lead:${ctx.leadId}` :
    ctx?.contactId ? `kommo:contact:${ctx.contactId}` :
    `web:${Date.now()}`;
  const out = await sendToAssistant(sessionId, userMsg || "");
  return out.text || "Listo ✅";
}
