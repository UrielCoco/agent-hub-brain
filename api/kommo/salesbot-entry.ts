import type { NextApiRequest, NextApiResponse } from "next";

const SESSIONS_KEY = "kommo_sessions";
const g: any = global as any;
g[SESSIONS_KEY] ||= new Map<string, { history: any[]; updatedAt: number }>();
const sessions: Map<string, { history: any[]; updatedAt: number }> = g[SESSIONS_KEY];

const MAX_TURNS = 8;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SYSTEM_PROMPT =
  process.env.ASSISTANT_SYSTEM_PROMPT ||
  "Eres Chuy, un asistente amable. Responde breve y útil. Mantén contexto del usuario.";

function isPlaceholder(s?: string){ return !!s && /^\{\{.*\}\}$/.test(s); }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 1) Parse body soportando widget_request (token, data, return_url) y request normal
  const ct = String(req.headers["content-type"] || "");
  const raw = (ct.includes("application/json") || ct.includes("form")) ? (req.body || {}) : {};
  const isWidget = !!raw.return_url || !!raw.token;

  const data = isWidget ? (raw.data || {}) : raw;
  const leadId = String(data.lead_id || data.leadId || "");
  const message = String(data.message || data.message_text || data.text || "");

  if (!leadId || !message || isPlaceholder(message)) {
    if (!isWidget) return res.status(200).json({ status: "fail", reply: "Sin mensaje o lead_id" });
    res.status(200).end(); // widget: responde rápido y termina
    return;
  }

  // 2) Responder inmediato si es widget_request (Kommo exige <=2s) y seguir async
  if (isWidget) res.status(200).end();

  // 3) Session + historial
  let session = sessions.get(leadId) || { history: [{ role: "system", content: SYSTEM_PROMPT }], updatedAt: Date.now() };
  session.history.push({ role: "user", content: message });
  const maxMsgs = MAX_TURNS * 2;
  const withoutSystem = session.history.filter(m => m.role !== "system");
  if (withoutSystem.length > maxMsgs) session.history = [session.history[0], ...session.history.slice(-maxMsgs)];

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, temperature: 0.6, messages: session.history })
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const j = await r.json();
    const reply = j?.choices?.[0]?.message?.content?.trim() || "";

    session.history.push({ role: "assistant", content: reply });
    session.updatedAt = Date.now();
    sessions.set(leadId, session);

    if (!isWidget) {
      // request "normal" (modo viejo)
      return res.status(200).json({ status: "success", reply });
    }

    // 4) widget_request: continuar el Salesbot (show + volver a escuchar)
    const returnUrl = String(raw.return_url || "");
    const body = {
      data: { status: "success", reply },
      execute_handlers: [
        { handler: "show", params: { type: "text", value: reply } },
        { handler: "goto", params: { type: "answer", step: 0 } }
      ]
    };

    // Preferente: con token OAuth si lo tienes
    const hdrs: Record<string,string> = { "Content-Type": "application/json" };
    if (process.env.KOMMO_ACCESS_TOKEN) hdrs["Authorization"] = `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`;

    await fetch(returnUrl, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
    return; // ya respondimos 200 antes
  } catch (e) {
    console.error("OpenAI/continue error:", e);
    if (!isWidget) return res.status(200).json({ status: "fail" });

    const returnUrl = String(raw.return_url || "");
    const body = {
      data: { status: "fail" },
      execute_handlers: [
        { handler: "show", params: { type: "text", value: "Ups, hubo un detalle. Intenta de nuevo." } },
        { handler: "goto", params: { type: "answer", step: 0 } }
      ]
    };
    await fetch(returnUrl, {
      method: "POST",
      headers: process.env.KOMMO_ACCESS_TOKEN ? { "Authorization": `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }
}
