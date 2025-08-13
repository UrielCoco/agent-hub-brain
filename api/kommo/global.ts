// /api/kommo/global.ts  — v4
import type { IncomingMessage, ServerResponse } from 'http';
import { sendToAssistant } from '../_lib/assistant';
import { addLeadNote } from '../_lib/kommo';

const BASE = process.env.KOMMO_BASE_URL!;          // ej: https://contactcocovolarecom.amocrm.com
const AUTH = `Bearer ${process.env.KOMMO_ACCESS_TOKEN!}`;

function get<T = string>(o: Record<string, any>, k: string): T | undefined {
  return (o[k] as T) ?? undefined;
}

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
  const text = await res.text().catch(()=>'');
  if (!res.ok) throw new Error(`Kommo ${path} -> ${res.status} ${text}`);
  try { return JSON.parse(text); } catch { return {}; }
}

// Envío por Chats API (chat_id)
async function sendChatMessage(chatId: string, text: string) {
  return kommoFetch('/api/v4/chats/messages', {
    method: 'POST',
    body: JSON.stringify({ chat_id: chatId, message: { text } }),
  });
}

// Fallback: Talks API (talk_id)
async function sendTalkMessage(talkId: string, text: string) {
  return kommoFetch('/api/v4/talks/messages', {
    method: 'POST',
    body: JSON.stringify({ talk_id: talkId, message: { text } }),
  });
}

export default async function handler(
  req: IncomingMessage & { method?: string; url?: string; headers: any },
  res: ServerResponse
) {
  try {
    if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }

    // Auth opcional
    const expected = process.env.WEBHOOK_SECRET;
    if (expected) {
      const u = new URL(req.url || '', 'http://localhost');
      const ok = u.searchParams.get('secret') === expected || req.headers['x-webhook-secret'] === expected;
      if (!ok) { res.statusCode = 401; res.end('unauthorized'); return; }
    }

    const { raw, parsed, ct } = await readForm(req);
    console.info('[GLOBAL v4] meta', { ct, rawPreview: raw.slice(0, 200) });
    console.info('[GLOBAL v4] keys', Object.keys(parsed));

    // ---- EXTRAER MENSAJE (tu cuenta envía message[add]...) ----
    const text =
      get<string>(parsed, 'message[add][0][text]') ||
      get<string>(parsed, 'messages[add][0][text]') ||
      get<string>(parsed, 'message[text]') ||
      get<string>(parsed, 'text');

    const chatId =
      get<string>(parsed, 'message[add][0][chat_id]') ||
      get<string>(parsed, 'messages[add][0][chat_id]') ||
      get<string>(parsed, 'chat[id]') ||
      get<string>(parsed, 'chat_id');

    const talkId =
      get<string>(parsed, 'message[add][0][talk_id]') ||
      get<string>(parsed, 'messages[add][0][talk_id]');

    const authorType =
      (get<string>(parsed, 'message[add][0][author][type]') ||
       get<string>(parsed, 'messages[add][0][author][type]') || '')
       .toLowerCase();

    // dirección del mensaje (in/out), útil para evitar loops
    const direction =
      (get<string>(parsed, 'message[add][0][type]') ||
       get<string>(parsed, 'messages[add][0][type]') || '')
       .toLowerCase();

    const leadIdStr =
      get<string>(parsed, 'message[add][0][entity_id]') ||
      get<string>(parsed, 'messages[add][0][entity_id]') ||
      get<string>(parsed, 'lead[id]') ||
      get<string>(parsed, 'lead_id');

    console.info('[GLOBAL v4] extracted', {
      authorType, direction, chatId, talkId, leadIdStr, textPreview: (text||'').slice(0,160)
    });

    // === LÓGICA DE FILTRO (ACEPTA external/contact/client/visitor o type=in) ===
    const inboundByDirection = direction === 'in';
    const inboundByAuthor = ['external', 'contact', 'client', 'visitor'].includes(authorType);
    const isInbound = inboundByDirection || inboundByAuthor;

    if (!isInbound) {
      console.info('[GLOBAL v4] ignored:not_inbound', { authorType, direction });
      res.statusCode = 200; res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({ ok:true, ignored:'not_inbound', authorType, direction }));
      return;
    }

    if (!text || (!chatId && !talkId)) {
      console.info('[GLOBAL v4] ignored:missing_fields', { haveText: !!text, chatId, talkId });
      res.statusCode = 200; res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({ ok:true, ignored:'not_a_message', haveText: !!text, chatId, talkId }));
      return;
    }

    const leadId = leadIdStr ? Number(leadIdStr) : undefined;
    const sessionId = leadId ? `kommo:lead:${leadId}` : `kommo:chat:${chatId || talkId}`;
    console.info('[GLOBAL v4] in', { sessionId });

    // Assistant
    const { text: answer, threadId } = await sendToAssistant(sessionId, text);
    console.info('[GLOBAL v4] out', { threadId, answerPreview: answer.slice(0, 200) });

    // Enviar respuesta (Chats o Talks)
    if (chatId) {
      await sendChatMessage(chatId, answer);
      console.info('[GLOBAL v4] msg_sent:chat', { chatId });
    } else if (talkId) {
      await sendTalkMessage(talkId, answer);
      console.info('[GLOBAL v4] msg_sent:talk', { talkId });
    }

    // Nota en lead (si hay)
    if (leadId) {
      try {
        await addLeadNote(leadId, `(kommo global)\n> Usuario: ${text}\n> Respuesta: ${answer}`);
        console.info('[GLOBAL v4] note_ok', { leadId });
      } catch (e: any) {
        console.warn('[GLOBAL v4] note_err', e?.message || e);
      }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({ ok:true, chat_id: chatId ?? null, talk_id: talkId ?? null, lead_id: leadId ?? null }));
  } catch (e: any) {
    console.error('[GLOBAL v4] fatal', e?.message || e);
    res.statusCode = 200; // no reintentos en loop
    res.end(JSON.stringify({ ok:false, error: e?.message || 'error' }));
  }
}
