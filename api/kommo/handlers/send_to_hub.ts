// agent-hub-brain/api/kommo/handlers/send_to_hub.ts
import { WEBHOOK_SECRET } from "../../../src/config.js";
import { processWithAssistant } from "../../../src/services/openai.js";
import { postNoteToLead, getLatestMessageForLead } from "../../../src/services/kommo.js";

type Any = Record<string, any>;

function firstStr(...v: any[]) {
  for (const x of v) {
    if (x === undefined || x === null) continue;
    const s = String(x).trim();
    if (s) return s;
  }
  return "";
}
function firstNum(...v: any[]) {
  for (const x of v) {
    const n = Number(x);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 0;
}
function mask(s?: string) {
  if (!s) return "";
  return s.length <= 8 ? "***" : `${s.slice(0, 2)}***${s.slice(-4)}`;
}

export const config = { runtime: "nodejs" };

export default async function handler(req: any, res: any) {
  const started = Date.now();
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Seguridad simple: ?secret=... en la URL del handler
    const qsSecret = (req.query?.secret as string) || "";
    if (WEBHOOK_SECRET && qsSecret !== WEBHOOK_SECRET) {
      console.warn("🚫 Handler secret inválido", {
        expected: mask(WEBHOOK_SECRET),
        got: mask(qsSecret),
      });
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Kommo envía { handler: "send_to_hub", params: {...}, ... }
    const body: Any = req.body || {};
    const p: Any = body.params ?? body;

    // Soportamos varios nombres de campo por si cambian
    let leadId = firstNum(p.lead_id, p.leadId, p["lead.id"]);
    let text = firstStr(p.text, p.message_text, p["message.text"], p.fallback_text);

    console.log("🤝 BOT handler: params", { keys: Object.keys(p || {}), leadId, hasText: !!text });

    // Fallback: si no llega texto, intentamos leerlo de Kommo
    if (!text && leadId) {
      try {
        const last = await getLatestMessageForLead(leadId);
        if (last && last.trim()) {
          text = last.trim();
          console.log("🔎 Fallback text from Kommo:", text.slice(0, 160));
        }
      } catch (e) {
        console.warn("⚠️ Fallback read error:", (e as any)?.response?.data || e);
      }
    }

    if (!leadId) return res.status(400).json({ error: "Missing lead_id" });
    if (!text) {
      console.warn("ℹ️ No text; ack");
      return res.status(204).end();
    }

    // Llama al Assistant
    const result = await processWithAssistant({ text, leadId });

    // Publica nota con la respuesta
    if (result.text) {
      try {
        await postNoteToLead(leadId, result.text);
        console.log("📝 Nota creada", { leadId, len: result.text.length });
      } catch (e) {
        console.error("💥 postNoteToLead error:", (e as any)?.response?.data || e);
      }
    }

    console.log("✅ send_to_hub OK", {
      leadId,
      thread: result.threadId,
      run_status: result.runStatus,
      ms: Date.now() - started,
    });

    // Respuesta para Kommo/Salesbot
    return res.status(200).json({
      ok: true,
      lead_id: leadId,
      text_in: text,
      text_out: result.text,
      thread_id: result.threadId,
      run_status: result.runStatus,
    });
  } catch (err: any) {
    console.error("💥 handler error:", err?.response?.data || err, { ms: Date.now() - started });
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
