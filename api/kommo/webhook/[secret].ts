// agent-hub-brain/api/kommo/webhook/[secret].ts
import { WEBHOOK_SECRET } from "../../../src/config.js";
import { processWithAssistant } from "../../../src/services/openai.js";
import { postNoteToLead, getLatestMessageForLead } from "../../../src/services/kommo.js";
import { retry } from "../../../src/utils/retry.js";

type Any = Record<string, any>;
const mask = (s?: string) => !s ? "" : (s.length <= 8 ? "***" : `${s.slice(0,2)}***${s.slice(-4)}`);

export const config = { runtime: "nodejs" };

export default async function handler(req: any, res: any) {
  const started = Date.now();
  try {
    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Secret: desde el path dinámico [secret] y/o ?secret=
    const pathSecret = String((req.query as Any)?.secret || "");
    const qsSecret   = String((req.query as Any)?.secret || "");
    if (WEBHOOK_SECRET && pathSecret !== WEBHOOK_SECRET && qsSecret !== WEBHOOK_SECRET) {
      console.warn("🚫 Secret inválido", { expected: mask(WEBHOOK_SECRET), got: mask(pathSecret || qsSecret) });
      return res.status(401).json({ error: "Unauthorized" });
    }

    const ua = String(req.headers["user-agent"] || "");
    const ct = String(req.headers["content-type"] || "");
    console.log("📩 KOMMO WEBHOOK HIT", {
      method, ua, ct, urlPath: req.url
    });

    const body = (req.body || {}) as Any;
    const q = (req.query || {}) as Any;

    const toNum = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const toStr = (v: any) => (v === undefined || v === null) ? "" : String(v).trim();

    // leadId: body, formatos bracket, o query
    let leadId =
      toNum(body?.lead_id) ||
      toNum(body?.conversation?.lead_id) ||
      toNum(body?.leads?.[0]?.id) ||
      toNum(body["leads[add][0][id]"]) ||
      toNum(q.lead_id);

    // text: body/message, o query
    let text =
      toStr(body?.text) ||
      toStr(body?.message?.text) ||
      toStr(body?.data?.message?.text) ||
      toStr(q.text) ||
      "";

    // Si llega placeholder crudo {{...}}, trátalo como vacío
    if (/^\s*\{\{.+\}\}\s*$/.test(text)) text = "";

    // fallback rápido desde query/body (last_message)
    if (!text) {
      const fb = toStr(q.fallback_text) || toStr(body?.last_message?.text) || "";
      if (fb && !/^\s*\{\{.+\}\}\s*$/.test(fb)) text = fb;
    }

    // Si sigue vacío, hacer polling de notas/mensajes (~5s)
    if (!text && leadId) {
      console.warn("⏳ Texto vacío: haré polling de notas ~5s…", { leadId });
      text = (await retry(() => getLatestMessageForLead(leadId), 6, 800)) || "";
    }

    if (!leadId) return res.status(400).json({ error: "Missing lead_id" });
    if (!text) {
      console.warn("ℹ️ No text after polling; ack");
      return res.status(204).end();
    }

    // Llamar al Assistant (sesión por lead)
    const result = await processWithAssistant({ text, leadId });

    // Publicar respuesta como nota en el LEAD
    if (result.text) {
      try {
        await postNoteToLead(leadId, result.text);
        console.log("📝 Nota creada", { leadId, len: result.text.length });
      } catch (e: any) {
        console.error("💥 postNoteToLead error:", e?.response?.data || e);
      }
    }

    console.log("✅ OK", {
      leadId,
      thread_id: result.threadId,
      run_status: result.runStatus,
      ms: Date.now() - started
    });

    return res.status(200).json({
      ok: true,
      leadId,
      text_in: text,
      text_out: result.text,
      thread_id: result.threadId,
      run_status: result.runStatus
    });
  } catch (err: any) {
    console.error("💥 webhook error:", err?.response?.data || err, { ms: Date.now() - started });
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}