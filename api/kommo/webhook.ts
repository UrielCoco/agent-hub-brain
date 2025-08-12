// /api/kommo/webhook.ts
import type { IncomingMessage, ServerResponse } from 'http';
import { sendToAssistant } from '../_lib/assistant';
import { addLeadNote } from '../_lib/kommo';
import { kvPush, redis } from '..//_lib/redis';

// --- utils de logging -------------------------------------------------
function cid() {
  // correlation id simple para rastrear una ejecución punta a punta
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function safePreview(s: string, n = 160) {
  return (s || '').replace(/\s+/g, ' ').slice(0, n);
}

// --- auth por secret (query o header) ---------------------------------
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

// --- lectura de body con meta (raw + content-type) --------------------
async function readBodyWithMeta(req: IncomingMessage): Promise<{
  parsed: any;
  raw: string;
  contentType: string;
}> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const ct = (req.headers['content-type'] || '').toString();

  // Intenta parsear según content-type
  if (ct.includes('application/json')) {
    try {
      return { parsed: JSON.parse(raw || '{}'), raw, contentType: ct };
    } catch {
      return { parsed: {}, raw, contentType: ct };
    }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const p = new URLSearchParams(raw);
    const o: Record<string, any> = {};
    for (const [k, v] of p.entries()) o[k] = v;
    return { parsed: o, raw, contentType: ct };
  }

  // Default: intenta JSON y si no, pasa raw
  try {
    return { parsed: JSON.parse(raw || '{}'), raw, contentType: ct };
  } catch {
    return { parsed: {}, raw, contentType: ct };
  }
}

// =====================================================================
export default async function handler(
  req: IncomingMessage & { method?: string; headers: any; url?: string },
  res: ServerResponse
) {
  const C = cid(); // correlation id
  const ua = (req.headers['user-agent'] || '').toString();
  const reqId = (req.headers['x-amocrm-requestid'] || '').toString();

  try {
    // START
    console.info('[WEBHOOK] start', { C, method: req.method, url: req.url, ua, reqId });

    if (req.method !== 'POST') {
      console.warn('[WEBHOOK] wrong_method', { C, method: req.method });
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const ver = verifySecret(req);
    if (!ver.ok) {
      console.warn('[WEBHOOK] unauthorized', { C });
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized', hint: 'secret en ?secret= o header x-webhook-secret' }));
      return;
    }

    const { parsed: body, raw, contentType } = await readBodyWithMeta(req);

    // Logs crudos (útiles para ver exactamente qué manda Salesbot/Kommo)
    console.info('[WEBHOOK] headers', { C, headers: req.headers });
    console.info('[WEBHOOK] meta', { C, contentType, rawPreview: safePreview(raw, 220) });
    console.info('[WEBHOOK] body.parsed', { C, body });

    // IGNORAR webhooks globales de cuenta (no traen texto del chat)
    if (!('text' in body) && !('message' in body)) {
      if (Object.keys(body).some((k) => k.startsWith('leads[')) || (body as any)['account[subdomain]']) {
        console.info('[WEBHOOK] ignored_account_webhook', { C });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, ignored: 'account_webhook' }));
        return;
      }
    }

    // Campos de interés
    const text: string = (body?.text ?? body?.message ?? '').toString();
    const leadIdRaw = body?.lead_id ?? body?.leadId ?? body?.entity_id;
    const leadId: number | undefined = leadIdRaw ? Number(leadIdRaw) : undefined;

    if (!text) {
      console.warn('[WEBHOOK] no_text', { C, bodyKeys: Object.keys(body || {}) });
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'text requerido' }));
      return;
    }

    // (Opcional) Rate limit 1s por lead para evitar floods
    try {
      if (leadId && redis) {
        const key = `rl:lead:${leadId}`;
        const hits = Number((await redis.incr(key)) || 0);
        if (hits === 1) await redis.expire(key, 1);
        if (hits > 5) {
          console.warn('[WEBHOOK] rate_limited', { C, leadId, hits });
          res.statusCode = 429;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'rate_limited' }));
          return;
        }
      }
    } catch (err) {
      console.warn('[WEBHOOK] ratelimit_error', { C, err: (err as any)?.message || err });
    }

    const sessionId = leadId ? `kommo:lead:${leadId}` : `kommo:chat:${body?.chat_id ?? body?.contact_id ?? 'unknown'}`;

    console.info('[WEBHOOK] in', { C, textPreview: safePreview(text), leadId, sessionId });

    // Guardamos turno del usuario si hay lead
    if (leadId) {
      await kvPush(`conv:lead:${leadId}`, JSON.stringify({ at: Date.now(), role: 'user', text }));
    }

    // Assistant
    const t0 = Date.now();
    const { text: answer, threadId } = await sendToAssistant(sessionId, text);
    const durMs = Date.now() - t0;

    console.info('[WEBHOOK] assistant.done', {
      C,
      ms: durMs,
      threadId,
      answerPreview: safePreview(answer),
    });

    // Guardamos turno del assistant y nota en Kommo si hay lead
    if (leadId) {
      await kvPush(`conv:lead:${leadId}`, JSON.stringify({ at: Date.now(), role: 'assistant', text: answer }));
      try {
        await addLeadNote(leadId, `(kommo webhook)\n> Usuario: ${text}\n> Respuesta: ${answer}`);
        console.info('[WEBHOOK] note_ok', { C, leadId });
      } catch (e: any) {
        console.warn('[WEBHOOK] addLeadNote_error', { C, err: e?.message || e });
      }
    }

    // Respuesta que utiliza Salesbot
    const payload = {
      ok: true,
      via: ver.via,
      lead_id: leadId ?? null,
      text_in: text,
      text_out: answer,
      thread_id: threadId,
    };

    console.info('[WEBHOOK] response', { C, status: 200, via: ver.via, hasLead: Boolean(leadId) });

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  } catch (e: any) {
    console.error('[WEBHOOK] fatal', { C, err: e?.message || e, stack: e?.stack });
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: e?.message ?? 'Server error' }));
  }
}
