import type { NextApiRequest, NextApiResponse } from "next";

const SESSIONS_KEY = "kommo_sessions_v1";
const g: any = global as any;
g[SESSIONS_KEY] ||= new Map<
  string,
  { history: any[]; lastMsg?: string; lastAt?: number }
>();
const sessions: Map<string, { history: any[]; lastMsg?: string; lastAt?: number }> =
  g[SESSIONS_KEY];

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SYSTEM_PROMPT =
  process.env.ASSISTANT_SYSTEM_PROMPT ||
  "Eres un asistente llamado Chuy. Respondes en español, breve y útil, manteniendo el contexto.";
const MAX_TURNS = 8;
const REBOUND_MS = 1500;

function isPlaceholder(s?: string) {
  return !!s && /^\{\{.*\}\}$/.test(s);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const providedSecret = (req.query.secret as string) || "";
  if (!process.env.WEBHOOK_SECRET || providedSecret !== process.env.WEBHOOK_SECRET) {
    return res.status(200).json({ status: "success", reply: "⚠️ Acceso restringido." });
  }

  const ct = (req.headers["content-type"] as string) || "";
  let body: any = {};
  try {
    if (ct.includes("application/json")) body = req.body || {};
    else if (ct.includes("application/x-www-form-urlencoded")) body = req.body || {};
  } catch {}

  const leadId = body.lead_id || body.leadId || "";
  const textIn = body.message || body.message_text || body.text || "";

  if (!leadId || !textIn || isPlaceholder(textIn)) {
    return res.status(200).json({ status: "success", reply: "¿Podrías repetir? No recibí tu mensaje." });
  }

  let s = sessions.get(leadId);
  if (!s) {
    s = { history: [{ role: "system", content: SYSTEM_PROMPT }] };
  }

  const now = Date.now();
  if (s.lastMsg === textIn && s.lastAt && now - s.lastAt < REBOUND_MS) {
    return res.status(200).json({ status: "success", reply: "" });
  }
  s.lastMsg = textIn;
  s.lastAt = now;

  s.history.push({ role: "user", content: textIn });

  const noSys = s.history.filter(m => m.role !== "system");
  const max = MAX_TURNS * 2;
  if (noSys.length > max) {
    s.history = [s.history[0], ...s.history.slice(-max)];
  }

  let reply = "";
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
        messages: s.history
      })
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const data = await r.json();
    reply = data?.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    console.error("OpenAI error:", e);
    reply = "Hubo un problema momentáneo con la IA. Intenta otra vez en unos segundos.";
  }

  if (reply) s.history.push({ role: "assistant", content: reply });
  sessions.set(leadId, s);

  return res.status(200).json({ status: "success", reply });
}
