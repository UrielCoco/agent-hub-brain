import type { NextApiRequest, NextApiResponse } from "next";

const g: any = global as any;

// ---- Stores en memoria (por servidor) ----
g.kommo_sessions ||= new Map<string, {
  history: any[];
  updatedAt: number;
  awaitingUser: boolean;        // true = esperamos un MENSAJE NUEVO del usuario
  lastUserText?: string;        // último texto del usuario normalizado
  lastUserAt?: number;          // timestamp del último texto del usuario
}>();
g.kommo_processed ||= new Map<string, number>(); // message_id -> timestamp (si llega)
g.kommo_seenSig   ||= new Map<string, number>(); // firma (leadId#msgNorm) -> ts

const sessions: Map<string, any> = g.kommo_sessions;
const processed: Map<string, number> = g.kommo_processed;
const seenSig: Map<string, number> = g.kommo_seenSig;

// ---- Config ----
const MAX_TURNS = 8;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SYSTEM_PROMPT =
  process.env.ASSISTANT_SYSTEM_PROMPT ||
  "Eres Chuy, un asistente amable. Responde breve y útil. Mantén contexto del usuario.";

const SIG_COOLDOWN_MS = 8000;   // ventana para no reprocesar el MISMO texto
const SEEN_TTL_MS      = 2 * 60 * 60 * 1000; // 2h para limpiar firmas vistas

// ---- Utils ----
const isPlaceholder = (s?: string) => !!s && /^\{\{.*\}\}$/.test(String(s).trim());
const sanitize = (v: any) => {
  if (v == null) return "";
  const s = String(v).trim();
  if (!s || isPlaceholder(s)) return "";
  if (s.toLowerCase() === "undefined" || s.toLowerCase() === "null") return "";
  return s;
};
const normalize = (s: string) =>
  s.toLowerCase().replace(/\s+/g, " ").trim();

function gcMaps() {
  const now = Date.now();
  for (const [id, ts] of processed.entries()) if (now - ts > 6 * 60 * 60 * 1000) processed.delete(id);
  for (const [sig, ts] of seenSig.entries()) if (now - ts > SEEN_TTL_MS) seenSig.delete(sig);
}

function log(ctx: string, obj: any) {
  try {
    const safe = JSON.parse(JSON.stringify(obj, (k, v) =>
      typeof v === "string" && /authorization|secret|api_key/i.test(k) ? "[redacted]" : v
    ));
    console.log(`[salesbot-entry] ${ctx}:`, safe);
  } catch {
    console.log(`[salesbot-entry] ${ctx}: (no-serializable)`);
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const t0 = Date.now();
  const secret = (req.query.secret as string) || "";
  const debug = (req.query.debug as string) === "1";

  log("REQ", { method: req.method, url: req.url, headers: { "content-type": req.headers["content-type"] } });

  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    log("AUTH", { ok: false, reason: "Forbidden/Secret mismatch" });
    return res.status(200).json({ status: "fail", reply: "Forbidden" });
  }

  const ct = req.headers["content-type"] || "";
  let body: any = {};
  try {
    if (ct.includes("application/json")) body = req.body || {};
    else if (ct.includes("application/x-www-form-urlencoded")) body = req.body || {};
  } catch (e) {
    log("PARSE_ERR", { e: String(e) });
  }

  const leadId     = sanitize(body.lead_id || body.leadId || "");
  const message    = sanitize(body.message || body.message_text || body.text || "");
  const messageId  = sanitize(body.message_id || body.messageId || "");
  const authorType = sanitize(body.author_type || body.authorType || "").toLowerCase(); // puede venir vacío
  const direction  = sanitize(body.direction || body.type || "").toLowerCase();         // puede venir vacío
  const channel    = sanitize(body.channel || body.source || "");

  log("BODY", {
    leadId,
    message_preview: typeof message === "string" ? message.slice(0, 120) : "(non-string)",
    messageId, authorType, direction, channel
  });

  if (!leadId || !message) {
    log("VALIDATION", { ok: false, reason: "missing leadId/message" });
    return res.status(200).json({ status: "fail", reply: "Sin mensaje o lead_id" });
  }

  // 0) Filtro claro de no-usuario (si los metadatos vienen bien)
  const clearlyNotUser =
    (authorType && (authorType === "internal" || authorType === "system")) ||
    direction === "out";
  if (clearlyNotUser) {
    log("FILTER", { ignored: true, reason: "not external/inbound" });
    return res.status(200).json({ status: "ignored" });
  }

  // 1) De-bounce por message_id si existe
  if (messageId) {
    if (processed.has(messageId)) {
      log("DEBOUNCE_ID", { ignored: true, messageId });
      return res.status(200).json({ status: "ignored" });
    }
    processed.set(messageId, Date.now());
  } else {
    log("DEBOUNCE_ID", { note: "sin messageId usable; seguimos" });
  }

  // 2) Estado de sesión por lead
  let session = sessions.get(leadId);
  if (!session) {
    session = {
      history: [{ role: "system", content: SYSTEM_PROMPT }],
      updatedAt: Date.now(),
      awaitingUser: true,   // al inicio esperamos usuario
      lastUserText: undefined,
      lastUserAt: 0
    };
    sessions.set(leadId, session);
  }

  // 3) Firma por contenido para evitar “hola” repetido sin message_id
  const msgNorm = normalize(message);
  const sig = `${leadId}#${msgNorm}`;
  log("MSG_SIG", { leadId, msgNorm, sig });
  const now = Date.now();
  gcMaps();

  // Solo dejamos pasar si:
  //  - estamos esperando usuario (awaitingUser === true)
  //  - y NO es el mismo texto en ventana de cooldown
  if (!session.awaitingUser) {
    log("ALT_GUARD", { ignored: true, reason: "awaitingUser=false (ya respondimos, falta entrada nueva)" });
    return res.status(200).json({ status: "ignored" });
  }
  const lastSeenAt = seenSig.get(sig) || 0;
  // if (now - lastSeenAt < SIG_COOLDOWN_MS) {
  //  log("SIG_DEDUP", { ignored: true, reason: "texto repetido en ventana", cooldown_ms: SIG_COOLDOWN_MS });
  //  return res.status(200).json({ status: "ignored" });
  //}
  // marcar firma y actualizar estado de usuario
  seenSig.set(sig, now);
  session.lastUserText = msgNorm;
  session.lastUserAt = now;

  // 4) Añadir user msg, recortar contexto
  session.history.push({ role: "user", content: message });
  const withoutSystem = session.history.filter((m: any) => m.role !== "system");
  if (withoutSystem.length > MAX_TURNS * 2) {
    session.history = [session.history[0], ...session.history.slice(-MAX_TURNS * 2)];
  }

  // 5) Marcar que YA NO esperamos usuario (vamos a responder)
  session.awaitingUser = false;

  // 6) Llamar a OpenAI
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.6,
        messages: session.history
      })
    });

    if (!r.ok) {
      const text = await r.text();
      log("OPENAI_BAD", { status: r.status, body: text.slice(0, 400) });
      // volvemos a esperar usuario para no bloquear
      session.awaitingUser = true;
      return res.status(200).json({ status: "fail" });
    }

    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || "";

    session.history.push({ role: "assistant", content: reply });
    session.updatedAt = now;
    // ¡Listo! ahora sí esperamos un NUEVO mensaje del usuario
    session.awaitingUser = true;
    sessions.set(leadId, session);

    const elapsed = Date.now() - t0;
    log("OK", { elapsed_ms: elapsed, reply_preview: reply.slice(0, 160) });

    const payload: any = { status: "success", reply };
    if (debug) {
      payload.debug = {
        leadId, authorType, direction, channel,
        model: MODEL, awaitingUser: session.awaitingUser,
        lastUserAt: session.lastUserAt, elapsed_ms: elapsed
      };
    }
    return res.status(200).json(payload);
  } catch (e: any) {
    session.awaitingUser = true; // no nos quedamos colgados
    log("OPENAI_ERR", { error: String(e) });
    return res.status(200).json({ status: "fail" });
  }
}
