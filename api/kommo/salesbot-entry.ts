// /Users/uriel/Projects/agent-hub-brain/api/kommo/salesbot-entry.ts
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

function isPlaceholder(s?: string) {
  return !!s && /^\{\{.*\}\}$/.test(s);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ct = String(req.headers["content-type"] || "");
  const raw = (ct.includes("application/json") || ct.includes("form")) ? (req.body || {}) : {};
  const isWidget = !!raw?.return_url; // widget_request trae return_url
  const data = isWidget ? (raw.data || {}) : raw;

  const leadId = String(data.lead_id || data.leadId || "");
  const message = String(data.message || data.message_text || data.text || "");
  const returnUrl: string = isWidget ? String(raw.return_url || "") : "";

  if (!leadId || !message || isPlaceholder(message)) {
    if (!isWidget) {
      return res.status(200).json({ status: "fail", reply: "Sin mensaje o lead_id" });
    }
    // widget_request: confirmar en <2s
    res.status(200).end();
    return;
  }

  // Responder rápido al widget_request
  if (isWidget) res.status(200).end();

  // Historial por lead
  let session =
    sessions.get(leadId) ||
    { history: [{ role: "system", content: SYSTEM_PROMPT }], updatedAt: Date.now() };

  session.history.push({ role: "user", content: message });

  // Recorte de historial (sin tocar el system)
  const maxMsgs = MAX_TURNS * 2;
  const withoutSystem = session.history.filter((m) => m.role !== "system");
  if (withoutSystem.length > maxMsgs) {
    session.history = [session.history[0], ...session.history.slice(-maxMsgs)];
  }

  try {
    // LLM
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.6,
        messages: session.history,
      }),
    });

    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const j = await r.json();
    const reply = j?.choices?.[0]?.message?.content?.trim() || "Listo 😉";

    session.history.push({ role: "assistant", content: reply });
    session.updatedAt = Date.now();
    sessions.set(leadId, session);

    if (!isWidget) {
      // Modo request “normal”
      return res.status(200).json({ status: "success", reply });
    }

    // Continuar Salesbot via return_url (requiere OAuth2 Bearer)
    if (!returnUrl) return;

    if (!process.env.KOMMO_ACCESS_TOKEN) {
      console.error("[Kommo continue] Falta KOMMO_ACCESS_TOKEN en el entorno");
    }

    const hdrs: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.KOMMO_ACCESS_TOKEN) {
      hdrs["Authorization"] = `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`;
    }

    const body = {
      data: { status: "success", reply },
      execute_handlers: [
        // Regresa al nodo 1 (conditions -> show {{json.reply}} -> wait_answer a 2)
        { handler: "goto", params: { type: "question", step: 1 } }
      ],
    };

    const cont = await fetch(returnUrl, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
    if (!cont.ok) {
      const txt = await cont.text().catch(() => "");
      console.error(`[Kommo continue] HTTP ${cont.status} ${cont.statusText} :: ${txt}`);
    }
    return;
  } catch (e) {
    console.error("OpenAI/continue error:", e);

    if (!isWidget) {
      return res.status(200).json({ status: "fail" });
    }

    if (!returnUrl) return;

    const hdrs: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.KOMMO_ACCESS_TOKEN) {
      hdrs["Authorization"] = `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`;
    }

    const body = {
      data: { status: "fail" },
      execute_handlers: [
        { handler: "goto", params: { type: "question", step: 1 } }
      ],
    };

    const cont = await fetch(returnUrl, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
    if (!cont.ok) {
      const txt = await cont.text().catch(() => "");
      console.error(`[Kommo continue][fail] HTTP ${cont.status} ${cont.statusText} :: ${txt}`);
    }
  }
}
