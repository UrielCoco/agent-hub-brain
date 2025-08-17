import type { NextApiRequest, NextApiResponse } from "next";

const SESSIONS_KEY = "kommo_sessions";
const PROCESSED_KEY = "kommo_processed";
const g: any = global as any;

g[SESSIONS_KEY] ||= new Map<string, { history: any[]; updatedAt: number }>();
g[PROCESSED_KEY] ||= new Map<string, number>(); // message_id -> timestamp

const sessions: Map<string, { history: any[]; updatedAt: number }> = g[SESSIONS_KEY];
const processed: Map<string, number> = g[PROCESSED_KEY];

const MAX_TURNS = 8;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SYSTEM_PROMPT =
  process.env.ASSISTANT_SYSTEM_PROMPT ||
  "Eres Chuy, un asistente amable. Responde breve y útil. Mantén contexto del usuario.";

/** Mini GC para processed cada 6h */
function gcProcessed(ttlMs = 6 * 60 * 60 * 1000) {
  const now = Date.now();
  for (const [id, ts] of processed.entries()) if (now - ts > ttlMs) processed.delete(id);
}

function isPlaceholder(s?: string) {
  return !!s && /^\{\{.*\}\}$/.test(s);
}

/** Helper para logging “bonito” (sin volcar secretos) */
function log(ctx: string, obj: any) {
  try {
    // Evita imprimir Authorization, secrets, etc.
    const safe = JSON.parse(
      JSON.stringify(obj, (k, v) =>
        typeof v === "string" && /authorization|secret|api_key/i.test(k) ? "[redacted]" : v
      )
    );
    console.log(`[salesbot-entry] ${ctx}:`, safe);
  } catch {
    console.log(`[salesbot-entry] ${ctx}: (no-serializable)`);
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const t0 = Date.now();
  const providedSecret = (req.query.secret as string) || "";
  const debug = (req.query.debug as string) === "1";

  // Log request básico
  log("REQ", {
    method: req.method,
    url: req.url,
    headers: {
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"]
    }
  });

  if (!process.env.WEBHOOK_SECRET || providedSecret !== process.env.WEBHOOK_SECRET) {
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

  const leadId = body.lead_id || body.leadId || "";
  const message = body.message || body.message_text || body.text || "";
  const messageId = body.message_id || body.messageId || "";
  const authorTypeRaw = body.author_type || body.authorType || "";
  const directionRaw = body.direction || body.type || "";
  const channel = body.channel || body.source || "";

  const authorType = String(authorTypeRaw || "").toLowerCase(); // external/internal/system, a veces vacío
  const direction = String(directionRaw || "").toLowerCase();   // in/out, a veces vacío

  log("BODY", {
    leadId,
    message_preview: typeof message === "string" ? message.slice(0, 200) : "(non-string)",
    messageId,
    authorType,
    direction,
    channel
  });

  if (!leadId || !message || isPlaceholder(message)) {
    log("VALIDATION", { ok: false, reason: "missing leadId/message or placeholder" });
    return res.status(200).json({ status: "fail", reply: "Sin mensaje o lead_id" });
  }

  /**
   * REGLA ROBUSTA:
   * - Sólo ignoramos si es CLARAMENTE no-usuario:
   *   authorType ∈ {internal, system}  O  direction === "out"
   * - Si vienen vacíos (muy común), asumimos usuario (mejor que silenciar).
   */
  const clearlyNotUser =
    (authorType && (authorType === "internal" || authorType === "system")) ||
    direction === "out";

  if (clearlyNotUser) {
    log("FILTER", { ignored: true, reason: "not external/inbound" });
    return res.status(200).json({ status: "ignored" });
  }

  // De-bounce por message_id si existe
  if (messageId) {
    if (processed.has(messageId)) {
      log("DEBOUNCE", { ignored: true, messageId });
      return res.status(200).json({ status: "ignored" });
    }
    processed.set(messageId, Date.now());
    gcProcessed();
  } else {
    log("DEBOUNCE", { note: "messageId vacío; se procesa igual" });
  }

  // Sesión por leadId
  let session = sessions.get(leadId);
  if (!session) {
    session = { history: [{ role: "system", content: SYSTEM_PROMPT }], updatedAt: Date.now() };
  }
  session.history.push({ role: "user", content: message });

  // Limitar contexto
  const maxMsgs = MAX_TURNS * 2;
  const withoutSystem = session.history.filter((m) => m.role !== "system");
  if (withoutSystem.length > maxMsgs) {
    session.history = [session.history[0], ...session.history.slice(-maxMsgs)];
  }

  // Llamada a OpenAI
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
      throw new Error(`OpenAI ${r.status}`);
    }

    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || "";

    session.history.push({ role: "assistant", content: reply });
    session.updatedAt = Date.now();
    sessions.set(leadId, session);

    const elapsed = Date.now() - t0;
    log("OK", { elapsed_ms: elapsed, reply_preview: reply.slice(0, 200) });

    const payload: any = { status: "success", reply };
    if (debug) {
      payload.debug = {
        leadId,
        authorType,
        direction,
        channel,
        model: MODEL,
        elapsed_ms: elapsed
      };
    }
    return res.status(200).json(payload);
  } catch (e: any) {
    const elapsed = Date.now() - t0;
    log("OPENAI_ERR", { error: String(e), elapsed_ms: elapsed });
    return res.status(200).json({ status: "fail" });
  }
}
