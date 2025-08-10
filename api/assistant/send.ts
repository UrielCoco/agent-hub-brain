import type { VercelRequest, VercelResponse } from "@vercel/node";
import { processWithAssistant } from "../../src/services/openai.js";
import { postNoteToLead } from "../../src/services/kommo.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { sessionId, text, leadId, channel } = (req.body || {}) as {
      sessionId?: string;
      text?: string;
      leadId?: number;
      channel?: string;
    };

    if (!text || (!sessionId && !leadId)) {
      return res.status(400).json({ error: "Missing text or (sessionId/leadId)" });
    }

    const result = await processWithAssistant({ text, sessionId, leadId });

    // Si viene leadId, también publicamos la respuesta en Kommo como nota
    if (leadId && result.text) {
      try {
        await postNoteToLead(leadId, result.text);
      } catch (e) {
        console.error("postNoteToLead error:", (e as any)?.response?.data || e);
      }
    }

    return res.status(200).json({
      ok: true,
      thread_id: result.threadId,
      run_status: result.runStatus,
      text: result.text,
      leadId: leadId || null,
      key: result.key,
      channel: channel || null,
    });
  } catch (err: any) {
    console.error("assistant/send error:", err?.response?.data || err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
