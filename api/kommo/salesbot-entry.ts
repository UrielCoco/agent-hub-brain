import type { NextApiRequest, NextApiResponse } from "next";

const SESSIONS_KEY = "kommo_sessions";
const g: any = global as any;
g[SESSIONS_KEY] ||= new Map<string, { history: any[]; updatedAt: number }>();
const sessions: Map<string, { history: any[]; updatedAt: number }> = g[SESSIONS_KEY];

const MAX_TURNS = 8;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SYSTEM_PROMPT =
  process.env.ASSISTANT_SYSTEM_PROMPT ||
  "Eres el asistente IA/AI DE Coco Volare, siempre presentate. Responde breve y útil no mas de 100 caracteres y siiempre en idioma de usuario. Mantén contexto del usuario y conversacion";

function isPlaceholder(s?: string) {
  return !!s && /^\{\{.*\}\}$/.test(s);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const providedSecret = (req.query.secret as string) || "";
  if (!process.env.WEBHOOK_SECRET || providedSecret !== process.env.WEBHOOK_SECRET) {
    return res.status(200).json({ status: "fail", reply: "Forbidden" });
  }

  const ct = (req.headers["content-type"] as string) || "";
  let body: any = {};
  try {
    if (ct.includes("application/json")) body = req.body || {};
    else if (ct.includes("application/x-www-form-urlencoded")) body = req.body || {};
  } catch {}

  const leadId = body.lead_id || body.leadId || "";
  let message = body.message || body.message_text || body.text || "";

  if (!leadId || !message || isPlaceholder(message)) {
    return res.status(200).json({ status: "fail", reply: "Sin mensaje o lead_id" });
  }

  let session = sessions.get(leadId);
  if (!session) {
    session = { history: [{ role: "system", content: SYSTEM_PROMPT }], updatedAt: Date.now() };
  }

  session.history.push({ role: "user", content: message });

  const maxMsgs = MAX_TURNS * 2;
  const noSys = session.history.filter(m => m.role !== "system");
  if (noSys.length > maxMsgs) {
    session.history = [session.history[0], ...session.history.slice(-maxMsgs)];
  }

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
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const data = await r.json();
    let reply = data?.choices?.[0]?.message?.content?.trim() || "";
    if (!reply) reply = "Estoy aquí. ¿Podrías reformular o dar más detalles?";

    session.history.push({ role: "assistant", content: reply });
    session.updatedAt = Date.now();
    sessions.set(leadId, session);

    return res.status(200).json({ status: "success", reply });
  } catch (e) {
    console.error("OpenAI error", e);
    return res.status(200).json({ status: "fail" });
  }
}
