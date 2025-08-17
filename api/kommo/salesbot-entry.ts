import type { NextApiRequest, NextApiResponse } from "next";

const g: any = global as any;

// ---- Stores en memoria ----
g.kommo_sessions ||= new Map<string, {
  history: any[];
  updatedAt: number;
  awaitingUser: boolean;  // true => esperamos mensaje NUEVO de usuario
  lastUserText?: string;  // último texto user normalizado
  lastUserAt?: number;    // ts último user
  lastReplyAt?: number;   // ts última respuesta assistant
}>();
g.kommo_processed ||= new Map<string, number>(); // message_id -> ts
g.kommo_seenSig   ||= new Map<string, number>(); // "lead#msgNorm" -> ts
g.kommo_leadLocks ||= new Map<string, number>(); // leadId -> ts (mutex simple)

const sessions: Map<string, any> = g.kommo_sessions;
const processed: Map<string, number> = g.kommo_processed;
const seenSig: Map<string, number> = g.kommo_seenSig;
const leadLocks: Map<string, number> = g.kommo_leadLocks;

// ---- Config ----
const MAX_TURNS = 8;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SYSTEM_PROMPT =
  process.env.ASSISTANT_SYSTEM_PROMPT ||
  "Eres Chuy, un asistente amable. Responde breve y útil. Mantén contexto del usuario.";

// Afinados para WhatsApp/Kommo:
const SIG_COOLDOWN_MS   = 8_000;   // dedupe por mismo texto
const REPLY_THROTTLE_MS = 3_000;   // ventana corta post-respuesta
const MUTEX_WINDOW_MS   = 1_500;   // anti reentrada por lead
const GC_TTL_MS         = 2 * 60 * 60 * 1000; // limpieza 2h

// ---- Utils ----
const isPlaceholder = (s?: string) => !!s && /^\{\{.*\}\}$/.test(String(s).trim());
const sanitize = (v: any) => {
  if (v == null) return "";
  const s = String(v).trim();
  if (!s || isPlaceholder(s)) return "";
  if (s.toLowerCase() === "undefined" || s.toLowerCase() === "null") return "";
  return s;
};
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

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

function gcMaps() {
  const now = Date.now();
  for (const [id, ts] of processed.entries()) if (now - ts > GC_TTL_MS) processed.delete(id);
  for (const [sig, ts] of seenSig.entries()) if (now - ts > GC_TTL_MS) seenSig.delete(sig);
  for (const [lead, ts] of leadLocks.entries()) if (now - ts > MUTEX_WINDOW_MS) leadLocks.delete(lead);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const t0 = Date.now();
  const secret = (req.query.secret as string) || "";
  const debug  = (req.query.debug as string) === "1";

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
  const authorType = sanitize(body.author_type || body.authorType || "").toLowerCase();
  const direction  = sanitize(body.direction || body.type || "").toLowerCase();
  const channel    = sanitize(body.channel   || body.source || "");

  log("BODY", {
    leadId,
    message_preview: typeof message === "string" ? message.slice(0, 120) : "(non-string)",
    messageId, authorType, direction, channel
  });

  if (!leadId || !message) {
    log("VALIDATION", { ok: false, reason: "missing leadId/message" });
    return res.status(200).json({ status: "fail", reply: "Sin mensaje o lead_id" });
  }

  gcMaps();

  // 0) Filtro claro de no-usuario
  const clearlyNotUser =
    (authorType && (authorType === "internal" || authorType === "system")) ||
    direction === "out";
  if (clearlyNotUser) {
    log("FILTER", { ignored: true, reason: "not external/inbound" });
    return res.status(200).json({ status: "ignored" });
  }

  // 1) Mutex por lead (anti reentrada multitrigger)
  const now = Date.now();
  const lockTs = leadLocks.get(leadId) || 0;
  if (now - lockTs < MUTEX_WINDOW_MS) {
    log("MUTEX", { ignored: true, reason: "lead locked", age_ms: now - lockTs });
    return res.status(200).json({ status: "ignored" });
  }
  leadLocks.set(leadId, now);

  // 2) De-bounce por message_id si existe
  if (messageId) {
    if (processed.has(messageId)) {
      log("DEBOUNCE_ID", { ignored: true, messageId });
      leadLocks.delete(leadId);
      return res.status(200).json({ status: "ignored" });
    }
    processed.set(messageId, now);
  } else {
    log("DEBOUNCE_ID", { note: "sin messageId usable; seguimos" });
  }

  // 3) Estado de sesión
  let session = sessions.get(leadId);
  if (!session) {
    session = {
      history: [{ role: "system", content: SYSTEM_PROMPT }],
      updatedAt: now,
      awaitingUser: true,
      lastUserText: undefined,
      lastUserAt: 0,
      lastReplyAt: 0
    };
    sessions.set(leadId, session);
  }

  // 4) Throttle post-respuesta: si acabamos de responder y llega un trigger “eco”
  if (session.lastReplyAt && now - session.lastReplyAt < REPLY_THROTTLE_MS) {
    log("REPLY_THROTTLE", { ignored: true, since_ms: now - session.lastReplyAt });
    leadLocks.delete(leadId);
    return res.status(200).json({ status: "ignored" });
  }

  // 5) Firma por contenido para evitar re-procesar mismo texto
  const msgNorm = normalize(message);
  const sig = `${leadId}#${msgNorm}`;
  const lastSeenAt = seenSig.get(sig) || 0;
  log("MSG_SIG", { leadId, msgNorm, sig, lastSeenAt, age_ms: now - lastSeenAt });

  // Alternancia: sólo procesamos si esperamos usuario
  if (!session.awaitingUser) {
    log("ALT_GUARD", { ignored: true, reason: "awaitingUser=false" });
    leadLocks.delete(leadId);
    return res.status(200).json({ status: "ignored" });
  }

  if (now - lastSeenAt < SIG_COOLDOWN_MS) {
    log("SIG_DEDUP", { ignored: true, reason: "texto repetido en ventana", cooldown_ms: SIG_COOLDOWN_MS });
    leadLocks.delete(leadId);
    return res.status(200).json({ status: "ignored" });
  }

  // Marcar firma y actualizar estado de usuario
  seenSig.set(sig, now);
  session.lastUserText = msgNorm;
  session.lastUserAt = now;

  // 6) Añadir mensaje de usuario y recortar contexto
  session.history.push({ role: "user", content: message });
  const withoutSystem = session.history.filter((m: any) => m.role !== "system");
  if (withoutSystem.length > MAX_TURNS * 2) {
    session.history = [session.history[0], ...session.history.slice(-MAX_TURNS * 2)];
  }

  // 7) Marcar que ya no esperamos usuario (vamos a responder)
  session.awaitingUser = false;

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
      session.awaitingUser = true; // no quedamos bloqueados
      leadLocks.delete(leadId);
      return res.status(200).json({ status: "fail" });
    }

    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || "";

    session.history.push({ role: "assistant", content: reply });
    session.updatedAt = now;
    session.awaitingUser = true;       // listo: volvemos a esperar usuario
    session.lastReplyAt = Date.now();  // para throttle
    sessions.set(leadId, session);

    const elapsed = Date.now() - t0;
    log("OK", { elapsed_ms: elapsed, reply_preview: reply.slice(0, 160) });
    leadLocks.delete(leadId);

    const payload: any = { status: "success", reply };
    if (debug) {
      payload.debug = {
        leadId, model: MODEL, awaitingUser: session.awaitingUser,
        lastUserAt: session.lastUserAt, lastReplyAt: session.lastReplyAt,
        elapsed_ms: elapsed
      };
    }
    return res.status(200).json(payload);
  } catch (e: any) {
    session.awaitingUser = true;
    leadLocks.delete(leadId);
    log("OPENAI_ERR", { error: String(e) });
    return res.status(200).json({ status: "fail" });
  }
}
