// /api/kommo/global.ts
import type { IncomingMessage, ServerResponse } from 'http';
import { sendToAssistant } from '../_lib/assistant';
import { addLeadNote } from '../_lib/kommo';

const BASE = process.env.KOMMO_BASE_URL!;
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
  if (!res.ok) {
    const t = await res.text().catch(()=>'');
    throw new Error(`Kommo ${path} -> ${res.status} ${t}`);
  }
  return res.json().catch(() => ({}));
}

// Enviar respuesta al mismo chat (WhatsApp/Instagram/Webchat)
async function sendChatMessage(chatId: string, text: string) {
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
      res.statusCode = 405; res.end('Method not allowed'); return;
    }

    // Auth opcional con secret (query o header)
    const expected = process.env.WEBHOOK_SECRET;
    if (expected) {
      const u = new URL(req.url || '', 'http://localhost');
      const ok =
        u.searchParams.get('secret') === expected ||
        req.headers['x-webhook-secret'] === expected;
      if (!ok) { res.statusCode = 401; res.end('unauthorized'); return; }
    }

    const { raw, parsed, ct } = await readForm(req);
    console.info('[GLOBAL] meta', { ct, rawPreview: raw.slice(0, 200) });
    console.info('[GLOBAL] keys', Object.keys(parsed));

    // ====== EXTRAER MENSAJE (singular o plural) ======
    // Tu cuenta está enviando "message[add][0][...]" (singular).
    const text =
      get<string>(parsed, 'message[add][0][text]') ||
      get<string>(parsed, 'messages[add][0][text]') || // fallback por si cambia
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
      get<string>(parsed, 'message[add][0][author][type]') ||
      get<string>(parsed, 'messages[add][0][author][type]');

    // lead (si viene, lo usamos para nota/contexto; no es obligatorio)
    const leadIdStr =
      get<string>(parsed, 'message[add][0][entity_id]') || // a veces mapea al lead
      get<string>(parsed, 'messages[add][0][entity_id]') ||
      get<string>(parsed, 'lead[id]') ||
      get<string>(parsed, 'lead_id');

    // Procesamos SOLO si es mensaje del cliente (no del manager)
    // En Kommo, suele ser "contact" para cliente y "user" para manager.
    if (authorType && authorType.toLowerCase() !== 'contact') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, ignored: 'not_contact_message', authorType }));
      return;
    }

    if (!text || !(chatId || talkId)) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, ignored: 'not_a_message', haveText: !!text, chatId, talkId }));
      return;
    }

    const leadId = leadIdStr ? Number(leadIdStr) : undefined;
    const sessionId = leadId ? `kommo:lead:${leadId}` : `kommo:chat:${chatId || talkId}`;

    console.info('[GLOBAL] in', { textPreview: text.slice(0, 160), chatId, talkId, leadId });

    // Assistant
    const { text: answer, threadId } = await sendToAssistant(sessionId, text);
    console.info('[GLOBAL] out', { threadId, answerPreview: answer.slice(0, 200) });

    // Responder al mismo chat
    if (chatId) {
      await sendChatMessage(chatId, answer);
      console.info('[GLOBAL] msg_sent', { chatId });
    } else {
      // Si por alguna razón solo viene talkId, aquí podríamos
      // implementar /api/v4/talks/messages. Tu payload trae ambos,
      // así que no hace falta por ahora.
      console.warn('[GLOBAL] no_chat_id', { talkId });
    }

    // Nota en lead (si existe)
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
    res.end(JSON.stringify({ ok: true, chat_id: chatId ?? null, talk_id: talkId ?? null, lead_id: leadId ?? null }));
  } catch (e: any) {
    console.error('[GLOBAL] fatal', e?.message || e);
    // 200 para que Kommo no reintente en loop
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, error: e?.message || 'error' }));
  }
}
