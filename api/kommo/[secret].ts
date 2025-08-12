import type { IncomingMessage, ServerResponse } from 'http';
import { sendToAssistant } from '../_lib/assistant';
import { addLeadNote } from '../_lib/kommo';

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const ct = (req.headers['content-type'] || '').toString();
  if (ct.includes('application/json')) { try { return JSON.parse(raw.toString()||'{}'); } catch { return {}; } }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const p = new URLSearchParams(raw.toString()); const o:any = {}; for (const [k,v] of p) o[k]=v; return o;
  }
  try { return JSON.parse(raw.toString()||'{}'); } catch { return {}; }
}

export default async function handler(
  req: IncomingMessage & { method?: string; url?: string },
  res: ServerResponse
) {
  try {
    if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }

    // extrae el último segmento como secret
    const u = new URL(req.url || '', 'http://localhost');
    const parts = u.pathname.split('/').filter(Boolean); // ["api","kommo","webhook","SECRET"]
    const secret = parts[parts.length - 1];
    const expected = process.env.WEBHOOK_SECRET;
    if (expected && secret !== expected) { res.statusCode = 401; res.end('unauthorized (path)'); return; }

    const body = await readBody(req);
    const text: string = body?.text ?? body?.message ?? '';
    const leadIdRaw = body?.lead_id ?? body?.leadId;
    const leadId = leadIdRaw ? Number(leadIdRaw) : undefined;
    if (!text || !leadId) { res.statusCode = 400; res.end(JSON.stringify({ error: 'text y lead_id requeridos' })); return; }

    const { text: answer, threadId } = await sendToAssistant(`kommo:lead:${leadId}`, text);

    // 👇 ahora sí, nota con entity_id
    await addLeadNote(leadId, `(kommo webhook path)\n> Usuario: ${text}\n> Respuesta: ${answer}`);

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, via: 'path', leadId, text_in: text, text_out: answer, thread_id: threadId, run_status: 'completed' }));
  } catch (e: any) {
    res.statusCode = 500; res.end(JSON.stringify({ error: e.message || 'Server error' }));
  }
}
