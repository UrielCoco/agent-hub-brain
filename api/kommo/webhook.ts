// agent-hub-brain/api/kommo/webhook.ts
import { processWithAssistant } from "../../src/services/openai.js";
import { postNoteToLead } from "../../src/services/kommo.js";
import type { KommoWebhookBody } from "../../src/types/kommo.js";
import { WEBHOOK_SECRET } from "../../src/config.js";

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    if (WEBHOOK_SECRET) {
      const token = req.headers["x-webhook-secret"];
      if (token !== WEBHOOK_SECRET) return res.status(401).json({ error: "Invalid webhook secret" });
    }

    const body = (req.body || {}) as KommoWebhookBody;
    const text = (body.text || "").toString().trim();
    const leadId = Number(body.lead_id || 0);

    if (!text) return res.status(400).json({ error: "Missing text" });
    if (!leadId) return res.status(400).json({ error: "Missing lead_id" });

    const result = await processWithAssistant({ text, leadId });

    if (result.text) await postNoteToLead(leadId, result.text);

    return res.status(200).json({
      ok: true,
      leadId,
      thread_id: result.threadId,
      run_status: result.runStatus,
      text: result.text
    });
  } catch (err: any) {
    console.error("kommo/webhook error:", err?.response?.data || err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
