import type { IncomingMessage, ServerResponse } from 'http';
import { sendToAssistant } from '../_lib/assistant';
import { addLeadNote } from '../_lib/kommo';

function verifySecret(req: IncomingMessage & { headers: any; url?: string }) {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) return { ok: true, via: 'none' as const };
  const hdr = req.headers['x-webhook-secret'];
  if (typeof hdr === 'string' && hdr === expected) return { ok: true, via: 'header' as const };
  try {
    const u = new URL(req.url || '', 'http://localhost');
    const q = u.searchParams.get('secret');
    if (q === expected) return { ok: true, via: 'query' as const };
  } catch {}
  return { ok: false as const };
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const ct = (req.headers['content-type'] || '').toString();
  if (ct.includes('application/json')) { try { return JSON.parse(raw.toString()||'{}'); } catch { return {}; } }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const p = new URLSearchParams(raw.toString()); const o:any={}; for (const [k,v] of p) o[k]=v; return o;
  }
  try { return JSON.parse(raw.toString()||'{}'); } catch { return {}; }
}

export default async function handler(
  req: IncomingMessage & { method?: string; headers:any; url?:string },
  res: ServerResponse
) {
  try {
    if (req.method !== 'POST') { res.statusCode=405; res.end(JSON.stringify({ error:'Method not allowed' })); return; }
    const ver = verifySecret(req);
    if (!ver.ok) { res.statusCode=401; res.end(JSON.stringify({ error:'unauthorized', hint:'secret en ?secret= o header x-webhook-secret' })); return; }

    const body = await readBody(req);
    const text: string = body?.text ?? body?.message ?? '';
    const leadIdRaw = body?.lead_id ?? body?.leadId;
    const leadId = leadIdRaw ? Number(leadIdRaw) : undefined;
    if (!text || !leadId) { res.statusCode=400; res.end(JSON.stringify({ error:'text y lead_id requeridos' })); return; }

    const sessionId = `kommo:lead:${leadId}`;
    const { text: answer, threadId } = await sendToAssistant(sessionId, text);

    // Deja evidencia en el lead (opcional pero útil)
    await addLeadNote(leadId, `(kommo webhook)\n> Usuario: ${text}\n> Respuesta: ${answer}`);

    // ⚠️ IMPORTANTE: devolvemos text_out para que Salesbot lo use directo
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({
      ok: true,
      via: ver.via,
      lead_id: leadId,
      text_in: text,
      text_out: answer,
      thread_id: threadId
    }));
  } catch (e:any) {
    res.statusCode=500; res.end(JSON.stringify({ error:e.message||'Server error' }));
  }
}
