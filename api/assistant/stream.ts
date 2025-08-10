import type { VercelRequest, VercelResponse } from "@vercel/node";
import { processWithAssistant } from "../../src/services/openai.js";
import { postNoteToLead } from "../../src/services/kommo.js";

export const config = {
  runtime: "nodejs20.x",
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") return res.status(405).end();

    const sessionId = (req.query.sessionId as string) || "";
    const text = (req.query.text as string) || "";
    const leadId = req.query.leadId ? Number(req.query.leadId) : undefined;

    if (!text || (!sessionId && !leadId)) {
      res.writeHead(400, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ error: "Missing text or (sessionId/leadId)", done: true })}\n\n`);
      return res.end();
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    // Avisar inicio
    res.write(`data: ${JSON.stringify({ status: "started" })}\n\n`);

    const result = await processWithAssistant({ text, sessionId, leadId });

    // Publicar en Kommo si aplica
    if (leadId && result.text) {
      try {
        await postNoteToLead(leadId, result.text);
      } catch (e) {
        console.error("postNoteToLead error:", (e as any)?.response?.data || e);
      }
    }

    // Entregar resultado (completo)
    res.write(`data: ${JSON.stringify({ text: result.text, thread_id: result.threadId })}\n\n`);

    // Cerrar
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err: any) {
    console.error("assistant/stream error:", err?.response?.data || err);
    try {
      res.write(`data: ${JSON.stringify({ error: err?.message || "Server error", done: true })}\n\n`);
      res.end();
    } catch {}
  }
}
