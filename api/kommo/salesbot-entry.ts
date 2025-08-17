import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Usuario -> WhatsApp -> Kommo -> Hub (este endpoint) -> Chat Backend (ASSISTANT_BASE_URL) -> respuesta
 */

const WEBHOOK_GUARD   = process.env.WEBHOOK_SECRET || "HE0HM550eyagKGRxTS0OM29L6tRUxLC61wJsvX3XsPIse2oScyJU3SR3CqtzjV5y";
const CHAT_BASE_URL   = process.env.ASSISTANT_BASE_URL || ""; // ej: https://coco-volare-ai-chat.vercel.app
const REBOUND_MS      = 2000;
const MAX_TURNS       = 8;
const SESSIONS_KEY    = "kommo_sessions_v4";

const CHAT_BRIDGE_PATHS = [
  "/api/kommo/bridge",
  "/api/bridge",
  "/api/chat/kommo-bridge"
];

const g: any = global as any;
g[SESSIONS_KEY] ||= new Map<string, { history: any[]; lastMsg?: string; lastAt?: number }>();
const sessions: Map<string, { history: any[]; lastMsg?: string; lastAt?: number }> = g[SESSIONS_KEY];

function isPlaceholder(s?: string) {
  return !!s && /^\{\{.*\}\}$/.test(s);
}

function parseBody(req: NextApiRequest): Record<string, any> {
  const raw = (req as any).body;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch {}
    const params = new URLSearchParams(raw);
    const obj: Record<string, any> = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    return obj;
  }
  return raw || {};
}

function pickFirst(src: Record<string, any>, keys: string[], suffixes: RegExp[] = []): string {
  for (const k of keys) if (src[k]) return String(src[k]);
  for (const [k, v] of Object.entries(src)) {
    if (suffixes.some(r => r.test(k))) return String(v);
  }
  return "";
}

function isFromContact(src: Record<string, any>): boolean {
  const authorType =
    src.author_type ||
    src["author[type]"] ||
    src["message[add][0][author][type]"] ||
    src["message[0][author][type]"] ||
    src["msg_author_type"] ||
    "";

  const msgType =
    src.message_type ||
    src["message[add][0][type]"] ||
    src["message[type]"] ||
    src["type"] ||
    "";

  const a = String(authorType).toLowerCase();
  const t = String(msgType).toLowerCase();

  if (a.includes("external") || a.includes("contact")) return true;
  if (t === "in") return true;
  return false;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const providedSecret = (req.query.secret as string) || "";
  if (!WEBHOOK_GUARD || providedSecret !== WEBHOOK_GUARD) {
    return res.status(200).json({ status: "success", reply: "⚠️ Acceso restringido." });
  }

  if (req.method !== "POST") {
    return res.status(200).json({ status: "success", reply: "" });
  }

  const body = parseBody(req);

  const leadId = pickFirst(
    body,
    ["lead_id", "leadId", "entity_id"],
    [/lead_id$/i, /\[entity_id\]$/i]
  );

  const textIn = pickFirst(
    body,
    ["message", "message_text", "text"],
    [/\[text\]$/i, /\[message_text\]$/i]
  ).trim();

  if (!isFromContact(body)) {
    return res.status(200).json({ status: "success", reply: "" });
  }

  if (!leadId || !textIn || isPlaceholder(textIn)) {
    return res.status(200).json({ status: "success", reply: "" });
  }

  let s = sessions.get(leadId);
  if (!s) s = { history: [] };
  const now = Date.now();
  if (s.lastMsg === textIn && s.lastAt && now - s.lastAt < REBOUND_MS) {
    return res.status(200).json({ status: "success", reply: "" });
  }
  s.lastMsg = textIn;
  s.lastAt = now;

  const base = s.history.length ? [...s.history] : [];
  base.push({ role: "user", content: textIn });
  const noSys = base.filter((m: any) => m.role !== "system");
  const history = noSys.length > MAX_TURNS * 2 ? noSys.slice(-MAX_TURNS * 2) : noSys;

  let reply = "";
  try {
    if (!CHAT_BASE_URL) throw new Error("ASSISTANT_BASE_URL no configurado");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    let ok = false;
    for (const path of CHAT_BRIDGE_PATHS) {
      try {
        const r = await fetch(new URL(path, CHAT_BASE_URL).toString(), {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            leadId,
            text: textIn,
            source: "kommo",
            channel: "whatsapp"
          })
        });
        if (r.ok) {
          const data = await r.json();
          reply = (data?.reply ?? "").toString().trim();
          ok = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    clearTimeout(timeout);

    if (!ok) throw new Error("No se pudo contactar el backend de chat");
    if (!reply) reply = "Claro, ¿me cuentas un poco más?";
  } catch (e) {
    console.error("Bridge error", e);
    reply = "Tuve un problema momentáneo. ¿Puedes intentar otra vez?";
  }

  s.history = [...history, { role: "assistant", content: reply }];
  sessions.set(leadId, s);

  return res
    .status(200)
    .setHeader("Content-Type", "application/json; charset=utf-8")
    .json({ status: "success", reply });
}
