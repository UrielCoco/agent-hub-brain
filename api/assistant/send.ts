import type { IncomingMessage, ServerResponse } from 'http';
import { sendToAssistant } from '../_lib/assistant';
import { addLeadNote } from '../_lib/kommo';

type Body = { sessionId?: string; text?: string; leadId?: number; channel?: string; };

export default async function handler(req: IncomingMessage & { method?: string }, res: ServerResponse) {
  try {
    if (req.method !== 'POST') {
      res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' })); return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body: Body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

    const { sessionId, text, leadId, channel } = body;
    if (!sessionId || !text) { res.statusCode = 400; res.end(JSON.stringify({ error:'sessionId y text requeridos' })); return; }

    const key = leadId ? `kommo:lead:${leadId}` : `web:${sessionId}`;
    const { text: answer, threadId } = await sendToAssistant(key, text);

    if (leadId) {
      const note = `(${channel ?? 'chat'})\n> Usuario: ${text}\n> Respuesta: ${answer}`;
      await addLeadNote(Number(leadId), note);
    }

    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({ ok:true, thread_id:threadId, run_status:'completed', text:answer, leadId:leadId ?? null }));
  } catch (e:any) {
    res.statusCode = 500; res.end(JSON.stringify({ error: e.message ?? 'Server error' }));
  }
}
