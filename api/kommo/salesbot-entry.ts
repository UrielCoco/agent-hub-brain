import type { NextApiRequest, NextApiResponse } from "next";

const SESSIONS_KEY = "kommo_sessions_v1";
const g: any = global as any;
g[SESSIONS_KEY] ||= new Map<string, { history: any[]; lastMsg?: string; lastAt?: number }>();
const sessions: Map<string, { history: any[]; lastMsg?: string; lastAt?: number }> = g[SESSIONS_KEY];

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_TURNS = 8;
const REBOUND_MS = 1500;

function isPlaceholder(s?: string) { return !!s && /^\{\{.*\}\}$/.test(s); }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const providedSecret = (req.query.secret as string) || "";
  if (!process.env.WEBHOOK_SECRET || providedSecret !== process.env.WEBHOOK_SECRET) {
    return res.status(200).json({ status: "success", reply: "⚠️ Acceso restringido." });
  }

  const ct = (req.headers["content-type"] as string) || "";
  let body: any = {};
  try { body = req.body || {}; } catch {}

  const leadId = body.lead_id || body.leadId || "";
  const textIn = body.message || body.message_text || body.text || "";

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

  const base = s.history.length ? s.history : [];
  base.push({ role: "user", content: textIn });
  const noSys = base.filter((m: any) => m.role !== "system");
  const max = MAX_TURNS * 2;
  const history = noSys.length > max ? base.slice(-max) : base;

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
        messages: history
      })
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const data = await r.json();
    reply = data?.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    console.error("OpenAI error", e);
    reply = "Tuve un problema momentáneo. ¿Puedes intentar otra vez?";
  }

  s.history = [...history, { role: "assistant", content: reply }];
  sessions.set(leadId, s);

  return res.status(200).json({ status: "success", reply });
}
