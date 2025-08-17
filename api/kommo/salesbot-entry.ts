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
  // 1) Parse body soportando widget_request (token, data, return_url) y request normal
  const ct = String(req.headers["content-type"] || "");
  const rawBody = (ct.includes("application/json") || ct.includes("form")) ? (req.body || {}) : {};

  // Kommo widget_request manda: { return_url, token, data: { ... } }
  const isWidget = !!rawBody?.return_url || !!rawBody?.token;
  const data = isWidget ? (rawBody.data || {}) : rawBody;

  const leadId = String(data.lead_id || data.leadId || "");
  const message = String(data.message || data.message_text || data.text || "");
  const returnUrl = isWidget ? String(rawBody.return_url || "") : "";
  const widgetToken = isWidget ? String(rawBody.token || "") : "";

  // 2) Validaciones mínimas
  if (!leadId || !message || isPlaceholder(message)) {
    if (!isWidget) {
      return res.status(200).json({ status: "fail", reply: "Sin mensaje o lead_id" });
    }
    // En widget_request: siempre responde rápido y termina.
    res.status(200).end();
    return;
  }

  // 3) Responder inmediato si es widget_request (Kommo exige <=2s)
  if (isWidget) {
    res.status(200).end();
  }

  // 4) Historial por lead
  let session =
    sessions.get(leadId) ||
    { history: [{ role: "system", content: SYSTEM_PROMPT }], updatedAt: Date.now() };

  session.history.push({ role: "user", content: message });

  // Recorte de historial
  const maxMsgs = MAX_TURNS * 2;
  const withoutSystem = session.history.filter((m) => m.role !== "system");
  if (withoutSystem.length > maxMsgs) {
    session.history = [session.history[0], ...session.history.slice(-maxMsgs)];
  }

  try {
    // 5) LLM
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
      // Modo "antiguo": devuelve el texto directo
      return res.status(200).json({ status: "success", reply });
    }

    // 6) Respuesta a Kommo (continuar escenario)
    // IMPORTANTE:
    // - No mandamos 'show' aquí para evitar duplicado: el paso 1 mostrará {{json.reply}}.
    // - Enviamos 'goto' -> question/1 para que aplique las conditions y luego wait_answer.
    if (!returnUrl) return; // no debería pasar, pero por si acaso

    const hdrs: Record<string, string> = { "Content-Type": "application/json" };
    // Prioriza el token del widget_request; si no, usa KOMMO_ACCESS_TOKEN si existe
    if (widgetToken) {
      hdrs["Authorization"] = `Bearer ${widgetToken}`;
    } else if (process.env.KOMMO_ACCESS_TOKEN) {
      hdrs["Authorization"] = `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`;
    }

    const body = {
      data: { status: "success", reply },
      execute_handlers: [
        { handler: "goto", params: { type: "question", step: 1 } }
      ],
    };

    await fetch(returnUrl, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
    return;
  } catch (e) {
    console.error("OpenAI/continue error:", e);

    if (!isWidget) {
      return res.status(200).json({ status: "fail" });
    }

    // En error: regresa al paso 1 para que muestre el mensaje de error definido ahí
    if (!returnUrl) return;

    const hdrs: Record<string, string> = { "Content-Type": "application/json" };
    if (widgetToken) {
      hdrs["Authorization"] = `Bearer ${widgetToken}`;
    } else if (process.env.KOMMO_ACCESS_TOKEN) {
      hdrs["Authorization"] = `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`;
    }

    const body = {
      data: { status: "fail" },
      execute_handlers: [
        { handler: "goto", params: { type: "question", step: 1 } }
      ],
    };

    await fetch(returnUrl, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
  }
}
