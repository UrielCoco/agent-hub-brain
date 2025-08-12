import type { IncomingMessage, ServerResponse } from 'http';
import { sendToAssistant } from '../_lib/assistant';
import { addLeadNote } from '../_lib/kommo';

function verifySecret(req: IncomingMessage & { headers: any; url?: string }) {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) return true;
  const header = req.headers['x-webhook-secret'];
  if (typeof header === 'string' && header === expected) return true;

  try {
    const u = new URL(req.url || '', 'http://localhost');
    const s = u.searchParams.get('secret');
    return s === expected;
  } catch { return false; }
}

export default async function handler(req: IncomingMessage & { method?: string; headers: any; url?: string }, res: ServerResponse) {
  try {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!verifySecret(req)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

    const text: string = body?.text ?? body?.message ?? '';
    const leadIdRaw = body?.lead_id ?? body?.leadId;
    const leadId: number | undefined = leadIdRaw ? Number(leadIdRaw) : undefined;

    if (!text || !leadId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'text y lead_id requeridos' }));
      return;
    }

    const sessionId = `kommo:lead:${leadId}`;
    const { text: answer } = await sendToAssistant(sessionId, text);

    await addLeadNote(leadId, `(kommo webhook)\n> Usuario: ${text}\n> Respuesta: ${answer}`);

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  } catch (err: any) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err?.message || 'Server error' }));
  }
}
