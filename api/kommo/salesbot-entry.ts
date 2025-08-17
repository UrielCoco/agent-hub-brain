import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Pipeline: Usuario -> WhatsApp -> Kommo -> Hub (ESTE) -> Chat Backend (ASSISTANT_BASE_URL) -> respuesta
 *
 * Este endpoint:
 * - SOLO responde a mensajes "entrantes" del contacto (evita loops)
 * - Hace de puente hacia tu backend del chat (assistant ya educado)
 * - Evita duplicados en ráfaga (anti-spam)
 * - Devuelve { status, reply } para que Kommo lo use como JSON
 */

// ------------------------- CONFIG -----------------------------------------
const WEBHOOK_GUARD   = process.env.WEBHOOK_SECRET || "";
const CHAT_BASE_URL   = process.env.ASSISTANT_BASE_URL || ""; // p.ej. https://coco-volare-ai-chat.vercel.app
const REBOUND_MS      = 2000; // evita eco por mensajes repetidos en milisegundos
const MAX_TURNS       = 8;    // historial local opcional (defensivo)
const SESSIONS_KEY    = "kommo_sessions_v3";

// Si tu backend expone otro path, ajústalo aquí (se probarán en orden):
const CHAT_BRIDGE_PATHS = [
  "/api/kommo/bridge",
  "/api/bridge",
  "/api/chat/kommo-bridge"
];

// --------------------- SESIÓN EN MEMORIA (hot-reload) ---------------------
const g: any = global as any;
g[SESSIONS_KEY] ||= new Map<string, { history: any[]; lastMsg?: string; lastAt?: number }>();
const sessions: Map<string, { history: any[]; lastMsg?: string; lastAt?: number }> = g[SESSIONS_KEY];

// ------------------------- UTILS ------------------------------------------
function isPlaceholder(s?: string) {
  return !!s && /^\{\{.*\}\}$/.test(s);
}

// Parse universal: JSON o x-www-form-urlencoded (incluye keys anidadas tipo message[add][0][text])
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

// Toma primer valor existente por clave exacta o por "sufijo" regex (para message[add][0][text])
function pickFirst(src: Record<string, any>, keys: string[], suffixes: RegExp[] = []): string {
  for (const k of keys) if (src[k]) return String(src[k]);
  for (const [k, v] of Object.entries(src)) {
    if (suffixes.some(r => r.test(k))) return String(v);
  }
  return "";
}

// ¿Mensaje del contacto/cliente? (no del bot/asesor) -> evita auto-responderse
function isFromContact(src: Record<string, any>): boolean {
  const authorType =
    src.author_type ||
    src["author[type]"] ||
    src["message[add][0][author][type]"] ||
    src["message[0][author][type]"] ||
    src["message[author][type]"] ||
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

  if (a.includes("external") || a.includes("contact")) return true; // usual en WA/IG
  if (t === "in") return true; // "in" = entrante del cliente
  return false;
}

// -------------------------- HANDLER ---------------------------------------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Guard de seguridad
  const providedSecret = (req.query.secret as string) || "";
  if (!WEBHOOK_GUARD || providedSecret !== WEBHOOK_GUARD) {
    return res.status(200).json({ status: "success", reply: "⚠️ Acceso restringido." });
  }

  if (req.method !== "POST") {
    return res.status(200).json({ status: "success", reply: "" });
  }

  const body = parseBody(req);

  // Extraer lead y texto
  const leadId = pickFirst(
    body,
    ["lead_id", "leadId", "lead", "entity_id", "entityId"],
    [/lead_id$/i, /\[entity_id\]$/i]
  );

  const textIn = pickFirst(
    body,
    ["message", "message_text", "text", "value"],
    [/\[text\]$/i, /\[message_text\]$/i]
  ).trim();

  // RESPETAR TURNOS: solo si escribe el CONTACTO
  if (!isFromContact(body)) {
    return res.status(200).json({ status: "success", reply: "" });
  }

  if (!leadId || !textIn || isPlaceholder(textIn)) {
    return res.status(200).json({ status: "success", reply: "" });
  }

  // Anti-duplicados
  let s = sessions.get(leadId);
  if (!s) s = { history: [] };
  const now = Date.now();
  if (s.lastMsg === textIn && s.lastAt && now - s.lastAt < REBOUND_MS) {
    return res.status(200).json({ status: "success", reply: "" });
  }
  s.lastMsg = textIn;
  s.lastAt = now;

  // Historial local (opcional, por si quieres auditar algo en caliente)
  const base = s.history.length ? [...s.history] : [];
  base.push({ role: "user", content: textIn });
  const noSys = base.filter((m: any) => m.role !== "system");
  const max = MAX_TURNS * 2;
  const history = noSys.length > max ? noSys.slice(-max) : noSys;

  // Llamada al backend del Chat (assistant ya educado)
  let reply = "";
  try {
    if (!CHAT_BASE_URL) throw new Error("ASSISTANT_BASE_URL no está configurado");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    // Probamos paths conocidos para evitar 404 si cambiaste la ruta
    let ok = false;
    let lastErr: any = null;

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
        if (!r.ok) { lastErr = new Error(`Bridge ${path} -> ${r.status} ${r.statusText}`); continue; }
        const data = await r.json();
        reply = (data?.reply ?? "").toString().trim();
        ok = true;
        break;
      } catch (e) {
        lastErr = e;
        continue;
      }
    }

    clearTimeout(timeout);

    if (!ok) throw lastErr || new Error("No se pudo contactar el Bridge del Chat");

    if (!reply) {
      // fallback ultra-defensivo: no dejar vacío para que Kommo no se quede “mudo”
      reply = "Claro. ¿Podrías contarme un poco más para ayudarte mejor?";
    }
  } catch (e) {
    console.error("Bridge error:", e);
    reply = "Tuve un problema momentáneo. ¿Puedes intentar otra vez?";
  }

  // Persistimos historial local (opcional)
  s.history = [...history, { role: "assistant", content: reply }];
  sessions.set(leadId, s);

  // Respuesta para Kommo (usar como JSON)
  return res
    .status(200)
    .setHeader("Content-Type", "application/json; charset=utf-8")
    .json({ status: "success", reply });
}
