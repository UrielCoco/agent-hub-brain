// /Users/uriel/Projects/agent-hub-brain/api/_lib/assistant.ts
// Utilidades para hablar con el Assistant.
// - getAssistantReply(): intenta primero TU backend (ASSISTANT_BASE_URL/api/reply).
//   Si no hay, usa OpenAI Assistants (Threads) si hay OPENAI_ASSISTANT_ID.
//   Si no hay Assistant ID, usa Chat Completions con OPENAI_MODEL.
//   Si no hay API key, regresa fallback amable.
// - sendToAssistant(): Threads API con sesión persistida opcional en Upstash Redis.

import OpenAI from "openai";
import type { Redis } from "@upstash/redis";

// ===== Env =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const ASSISTANT_BASE_URL = process.env.ASSISTANT_BASE_URL || ""; // p.ej. https://coco-volare-ai-chat.vercel.app
const ASSISTANT_API_KEY = process.env.ASSISTANT_API_KEY || "";   // opcional Bearer para tu backend
const ASSISTANT_TIMEOUT_MS = Number(process.env.ASSISTANT_TIMEOUT_MS || 20000);

// ===== OpenAI client (si hay API KEY) =====
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ===== Redis opcional para persistir threads =====
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
let useRedis = Boolean(REDIS_URL && REDIS_TOKEN);
let redis: InstanceType<typeof Redis> | null = null;

async function ensureRedis() {
  if (!useRedis) return;
  if (redis) return;
  const mod = await import("@upstash/redis");
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n = 800) {
  return (s || "").slice(0, n);
}

function buildSessionId(ctx: any): string {
  return ctx?.leadId
    ? `kommo:lead:${ctx.leadId}`
    : ctx?.contactId
    ? `kommo:contact:${ctx.contactId}`
    : ctx?.talkId
    ? `kommo:talk:${ctx.talkId}`
    : `web:${Date.now()}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// =================== Threads API (Assistants) ===================
export async function sendToAssistant(sessionId: string, userText: string) {
  if (!openai) throw new Error("OPENAI_API_KEY faltante");
  if (!OPENAI_ASSISTANT_ID) throw new Error("Falta OPENAI_ASSISTANT_ID");

  const key = `thread:${sessionId}`;
  let threadId = await kvGet(key);
  if (!threadId) {
    const thr = await openai.beta.threads.create();
    threadId = thr.id;
    await kvSet(key, threadId);
  }

  await openai.beta.threads.messages.create(threadId as string, {
    role: "user",
    content: userText || "",
  });

  const run = await openai.beta.threads.runs.create(threadId as string, {
    assistant_id: OPENAI_ASSISTANT_ID,
  });

  // Polling simple
  let status = run.status;
  for (let i = 0; i < 40; i++) {
    await sleep(600);
    const cur = await openai.beta.threads.runs.retrieve(threadId as string, run.id);
    status = cur.status;
    if (status === "completed") break;
    if (["failed", "cancelled", "expired"].includes(status)) {
      throw new Error(`Run ${status}`);
    }
  }

  const msgs = await openai.beta.threads.messages.list(threadId as string, { limit: 10 });
  const last = msgs.data.find((m: any) => m.role === "assistant");
  const text =
    (last?.content?.[0] as any)?.text?.value ??
    (Array.isArray(last?.content)
      ? last!.content.map((c: any) => c?.text?.value).filter(Boolean).join("\n")
      : "");

  return { text: text || "", threadId };
}

// =================== Orquestador de respuesta ===================
export async function getAssistantReply(
  userMsg: string,
  ctx: {
    subdomain?: string;
    leadId?: string;
    contactId?: string;
    talkId?: string;
    traceId?: string;
  } = {}
): Promise<string> {
  const message = String(userMsg || "").trim();

  // 1) Preferir TU backend externo (coco-volare-ai-chat)
  if (ASSISTANT_BASE_URL) {
    try {
      const url = `${ASSISTANT_BASE_URL.replace(/\/+$/, "")}/api/reply`;
      const r = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(ASSISTANT_API_KEY ? { Authorization: `Bearer ${ASSISTANT_API_KEY}` } : {}),
          },
          body: JSON.stringify({
            message,
            leadId: ctx.leadId,
            contactId: ctx.contactId,
            talkId: ctx.talkId,
            subdomain: ctx.subdomain,
            traceId: ctx.traceId,
          }),
        },
        ASSISTANT_TIMEOUT_MS
      );

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`Assistant backend HTTP ${r.status}: ${truncate(t, 200)}`);
      }
      const j = await r.json().catch(() => ({} as any));
      const reply = j?.reply ?? j?.text ?? j?.answer ?? "";
      if (reply) return String(reply);
      // si vino vacío, cae al fallback
    } catch (e) {
      // No reventamos; seguimos a fallback
    }
  }

  // 2) Si hay Assistant ID -> Threads API
  if (openai && OPENAI_ASSISTANT_ID) {
    try {
      const sessionId = buildSessionId(ctx);
      const out = await sendToAssistant(sessionId, message);
      if (out?.text) return out.text;
    } catch (e) {
      // continuar a fallback
    }
  }

  // 3) Fallback: Chat Completions directo
  if (openai) {
    try {
      const completion = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.6,
        messages: [
          {
            role: "system",
            content:
              "Eres el asistente de Coco Volare. Responde breve, claro y en español mexicano. Si falta contexto, pide datos puntuales.",
          },
          { role: "user", content: message || "Hola" },
        ],
      });
      const text =
        completion.choices?.[0]?.message?.content?.toString().trim() ||
        "Listo, ¿algo más?";
      return text;
    } catch (e) {
      // continuar al último fallback
    }
  }

  // 4) Último recurso si no hay API key ni backend
  if (!message) return "¡Hola! ¿En qué puedo ayudarte hoy?";
  return `Te entendí: "${message}". ¿Quieres cotización, reservar o conocer disponibilidad?`;
}
