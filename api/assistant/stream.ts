// agent-hub-brain/api/assistant/stream.ts
import { processWithAssistant } from "../../src/services/openai.js";
import { postNoteToLead } from "../../src/services/kommo.js";

// En archivo, Vercel solo acepta "nodejs" o "edge"
export const config = { runtime: "nodejs" };

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "GET") return res.status(405).end();

    const sessionId = (req.query.sessionId as string) || "";
    const text = (req.query.text as string) || "";
    const leadId = req.query.leadId ? Number(req.query.leadId) : undefined;

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    if (!text || (!sessionId && !leadId)) {
      res.write(`data: ${JSON.stringify({ error: "Missing text or (sessionId/leadId)", done: true })}\n\n`);
      return res.end();
    }

    res.write(`data: ${JSON.stringify({ status: "started" })}\n\n`);

    const result = await processWithAssistant({ text, sessionId, leadId });

    if (leadId && result.text) {
      try { await postNoteToLead(leadId, result.text); } catch (e) {
        console.error("postNoteToLead error:", (e as any)?.response?.data || e);
      }
    }

    res.write(`data: ${JSON.stringify({ text: result.text, thread_id: result.threadId })}\n\n`);
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
