// /api/kommo/global.ts
import type { IncomingMessage, ServerResponse } from 'http';
import { sendToAssistant } from '../_lib/assistant';
import { addLeadNote } from '../_lib/kommo';

const BASE = process.env.KOMMO_BASE_URL!;
const AUTH = `Bearer ${process.env.KOMMO_ACCESS_TOKEN!}`;

async function readForm(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const ct = (req.headers['content-type'] || '').toString();

  let parsed: Record<string, any> = {};
  if (ct.includes('application/x-www-form-urlencoded')) {
    const p = new URLSearchParams(raw);
    for (const [k, v] of p.entries()) parsed[k] = v;
  } else {
    try { parsed = JSON.parse(raw || '{}'); } catch { parsed = {}; }
  }
  return { raw, parsed, ct };
}

function get<T = string>(o: Record<string, any>, k: string): T | undefined {
  return (o[k] as T) ?? undefined;
}

async function kommoFetch(path: string, init: RequestInit = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Authorization': AUTH,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(init.headers || {})
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>'');
    throw new Error(`Kommo ${path} -> ${res.status} ${t}`);
  }
  return res.json().catch(() => ({}));
}

async function sendChatMessage(chatId: string, text: string) {
  // Chats API: envía mensaje al mismo chat (WA/IG/Web)
  return kommoFetch('/api/v4/chats/messages', {
    method: 'POST',
    body: JSON.stringify({
      chat_id: chatId,
      message: { text },
    }),
  });
}

export default async function handler(
  req: IncomingMessage & { method?: string; url?: string; headers: any },
  res: ServerResponse
) {
  try {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('Method not allowed');
      return;
    }

    // auth opcional por secret
    const expected = process.env.WEBHOOK_SECRET;
    if (expected) {
      const u = new URL(req.url || '', 'http://localhost');
      const ok =
        u.searchParams.get('secret') === expected ||
        req.headers['x-webhook-secret'] === expected;
      if (!ok) {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
    }

    const { raw, parsed, ct } = await readForm(req);
    console.info('[GLOBAL] meta', { ct, rawPreview: raw.slice(0, 240) });
    console.info('[GLOBAL] keys', Object.keys(parsed));

    // buscamos estructura de "mensaje agregado"
    // Kommo suele mandar messages[add][0][text], messages[add][0][chat_id], messages[add][0][lead_id]
    const text = get<string>(parsed, 'messages[add][0][text]') ||
                 get<string>(parsed, 'message[text]') ||
                 get<string>(parsed, 'text');

    const chatId = get<string>(parsed, 'messages[add][0][chat_id]') ||
                   get<string>(parsed, 'chat[id]') ||
                   get<string>(parsed, 'chat_id');

    const leadIdStr = get<string>(parsed, 'messages[add][0][lead_id]') ||
                      get<string>(parsed, 'lead[id]') ||
                      get<string>(parsed, 'lead_id');

    if (!text || !chatId) {
      // No es evento de mensaje; aceptamos para no reintentar
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, ignored: 'not_a_message' }));
      return;
    }

    const leadId = leadIdStr ? Number(leadIdStr) : undefined;
    const sessionId = leadId ? `kommo:lead:${leadId}` : `kommo:chat:${chatId}`;

    console.info('[GLOBAL] in', { chatId, leadId, textPreview: text.slice(0, 120) });

    // Llama Assistant
    const { text: answer, threadId } = await sendToAssistant(sessionId, text);
    console.info('[GLOBAL] out', { threadId, answerPreview: answer.slice(0, 160) });

    // Responde al chat
    await sendChatMessage(chatId, answer);
    console.info('[GLOBAL] msg_sent', { chatId });

    // Nota en lead (si hay)
    if (leadId) {
      try {
        await addLeadNote(leadId, `(kommo global)\n> Usuario: ${text}\n> Respuesta: ${answer}`);
        console.info('[GLOBAL] note_ok', { leadId });
      } catch (e: any) {
        console.warn('[GLOBAL] note_err', e?.message || e);
      }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, chat_id: chatId, lead_id: leadId ?? null }));
  } catch (e: any) {
    console.error('[GLOBAL] fatal', e?.message || e);
    res.statusCode = 200; // respondemos 200 para que Kommo no reintente en loop
    res.end(JSON.stringify({ ok: false, error: e?.message || 'error' }));
  }
}
