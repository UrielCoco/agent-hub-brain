// /api/kommo/webhook.ts
import type { IncomingMessage, ServerResponse } from 'http';
import { sendToAssistant } from '../_lib/assistant';
import { addLeadNote } from '../_lib/kommo';
import { kvPush } from '../_lib/redis';

// --- auth por secret (query o header) ---
function verifySecret(req: IncomingMessage & { headers: any; url?: string }) {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) return { ok: true, via: 'none' as const };

  const hdr = req.headers['x-webhook-secret'];
  if (typeof hdr === 'string' && hdr === expected) return { ok: true, via: 'header' as const };

  try {
    const u = new URL(req.url || '', 'http://localhost');
    if (u.searchParams.get('secret') === expected) return { ok: true, via: 'query' as const };
  } catch {}
  return { ok: false as const };
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const ct = (req.headers['content-type'] || '').toString();

  if (ct.includes('application/json')) {
    try { return JSON.parse(raw.toString() || '{}'); } catch { return {}; }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const p = new URLSearchParams(raw.toString());
    const o: Record<string, any> = {};
    for (const [k, v] of p.entries()) o[k] = v;
    return o;
  }
  try { return JSON.parse(raw.toString() || '{}'); } catch { return {}; }
}

export default async function handler(
  req: IncomingMessage & { method?: string; headers: any; url?: string },
  res: ServerResponse
) {
  try {
    if (req.method !== 'POST') {
      res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' })); return;
    }

    const ver = verifySecret(req);
    if (!ver.ok) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized', hint: 'secret en ?secret= o header x-webhook-secret' }));
      return;
    }

    const body = await readBody(req);
    const text: string = body?.text ?? body?.message ?? '';
    const leadIdRaw = body?.lead_id ?? body?.leadId;
    const leadId: number | undefined = leadIdRaw ? Number(leadIdRaw) : undefined;

    if (!text || !leadId) {
      res.statusCode = 400; res.end(JSON.stringify({ error: 'text y lead_id requeridos' })); return;
    }

    const sessionId = `kommo:lead:${leadId}`;

    // Guardamos turno del usuario en Redis
    await kvPush(`conv:lead:${leadId}`, JSON.stringify({ at: Date.now(), role: 'user', text }));

    // Llamamos al assistant
    const { text: answer, threadId } = await sendToAssistant(sessionId, text);

    // Guardamos turno del assistant
    await kvPush(`conv:lead:${leadId}`, JSON.stringify({ at: Date.now(), role: 'assistant', text: answer }));

    // Nota en el lead (útil para auditoría)
    await addLeadNote(leadId, `(kommo webhook)\n> Usuario: ${text}\n> Respuesta: ${answer}`);

    // Respuesta para Salesbot (usará text_out para enviar al canal)
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      via: ver.via,
      lead_id: leadId,
      text_in: text,
      text_out: answer,
      thread_id: threadId
    }));
  } catch (e: any) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message ?? 'Server error' }));
  }
}
