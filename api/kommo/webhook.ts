import type { IncomingMessage, ServerResponse } from 'http';
import { sendToAssistant } from '../_lib/assistant';
import { addLeadNote } from '../_lib/kommo';

function getPathSecret(req: IncomingMessage & { url?: string }) {
  try {
    // /api/kommo/webhook/SECRET  -> SECRET
    const u = new URL(req.url || '', 'http://localhost');
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    // si la ruta termina exactamente en "webhook", no hay secret en path
    if (last && last !== 'webhook') return last;
    return null;
  } catch {
    return null;
  }
}

function verifySecret(req: IncomingMessage & { headers: any; url?: string }) {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) return { ok: true, reason: 'no-secret-configured' };

  // 1) header
  const hdr = req.headers['x-webhook-secret'];
  if (typeof hdr === 'string' && hdr === expected) return { ok: true, from: 'header' };

  // 2) query ?secret=
  try {
    const u = new URL(req.url || '', 'http://localhost');
    const q = u.searchParams.get('secret');
    if (q === expected) return { ok: true, from: 'query' };
  } catch {}

  // 3) path /api/kommo/webhook/{secret}
  const pathSecret = getPathSecret(req);
  if (pathSecret === expected) return { ok: true, from: 'path' };

  return { ok: false as const, reason: 'mismatch' };
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  const ctype = (req.headers['content-type'] || '').toString();

  if (ctype.includes('application/json')) {
    try { return JSON.parse(raw.toString() || '{}'); } catch { return {}; }
  }

  if (ctype.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw.toString());
    const obj: Record<string, any> = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    return obj;
  }

  // fallback
  try { return JSON.parse(raw.toString() || '{}'); } catch { return {}; }
}

export default async function handler(
  req: IncomingMessage & { method?: string; headers: any; url?: string },
  res: ServerResponse
) {
  try {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const ver = verifySecret(req);
    if (!ver.ok) {
      res.statusCode = 401;
      res.end(JSON.stringify({
        error: 'unauthorized',
        hint: 'Pass secret in path (/api/kommo/webhook/{SECRET}), query (?secret=) o header x-webhook-secret'
      }));
      return;
    }

    const body = await readBody(req);
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
    res.end(JSON.stringify({ ok: true, via: ver.from || ver.reason }));
  } catch (err: any) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err?.message || 'Server error' }));
  }
}
