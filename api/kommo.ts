// api/kommo.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * ====== ENV ======
 * - Usa token de larga duración (NO refresh).
 * - Puedes setear UNO de los dos:
 *   - KOMMO_BASE_URL = https://<sub>.kommo.com   (o .amocrm.com si aplica)
 *   - KOMMO_SUBDOMAIN = <sub>
 */
const KOMMO_BASE_URL = (process.env.KOMMO_BASE_URL || '').trim();
const KOMMO_SUBDOMAIN = (process.env.KOMMO_SUBDOMAIN || '').trim();
const KOMMO_ACCESS_TOKEN = (process.env.KOMMO_ACCESS_TOKEN || '').trim();

const BRIDGE_SECRET = (process.env.WEBHOOK_SECRET || '').trim();

/** ====== Utils de logging ====== */
function nowISO() { return new Date().toISOString(); }
function randId() { return Math.random().toString(36).slice(2, 10); }
function preview(str: any, max = 300) {
  const s = typeof str === 'string' ? str : JSON.stringify(str);
  return s.length > max ? s.slice(0, max) + `… (${s.length} chars)` : s;
}
function log(ctx: string, msg: string, data?: any) {
  // No exponemos secretos
  const clean = data ? JSON.parse(JSON.stringify(data)) : undefined;
  if (clean?.headers?.Authorization) clean.headers.Authorization = '<redacted>';
  console.log(JSON.stringify({ ts: nowISO(), ctx, msg, data: clean }));
}

/** ====== Base URL normalizada ====== */
function kommoBase(): string {
  let raw =
    (KOMMO_BASE_URL && KOMMO_BASE_URL.trim()) ||
    (KOMMO_SUBDOMAIN ? `${KOMMO_SUBDOMAIN}.kommo.com` : '');

  if (!raw) throw new Error('KOMMO_BASE_URL or KOMMO_SUBDOMAIN missing');

  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  return raw.replace(/\/+$/, '');
}
function apiV4(p: string) { return `${kommoBase()}/api/v4/${p.replace(/^\/+/, '')}`; }

/** ====== Headers con token largo ====== */
function authHeaders() {
  if (!KOMMO_ACCESS_TOKEN) throw new Error('KOMMO_ACCESS_TOKEN missing');
  return { Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
}

/** ====== Fetch con logs + backoff (sin refresh) ====== */
async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function kommoFetch(
  ctx: string,
  path: string,
  init: RequestInit = {},
  attempt = 0
): Promise<Response> {
  const url = apiV4(path);
  const headers = { ...authHeaders(), ...(init.headers || {}) } as Record<string, string>;
  const bodyPreview = init.body ? preview(init.body, 400) : undefined;

  log(ctx, 'kommo_request', { method: init.method || 'GET', url, attempt, bodyPreview });

  const res = await fetch(url, { ...init, headers });

  const text = await res.text().catch(() => '');
  const isJson = text.startsWith('{') || text.startsWith('[');
  const body = isJson ? (() => { try { return JSON.parse(text); } catch { return text; } })() : text;

  if (res.ok) {
    log(ctx, 'kommo_response_ok', { status: res.status, url, bodyPreview: preview(body, 400) });
    // reconstruimos Response para no perder el body
    return new Response(isJson ? JSON.stringify(body) : String(body), {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') || 'application/json' }
    });
  }

  // Errores → backoff en 429 / 5xx
  const retriable = res.status === 429 || res.status >= 500;
  log(ctx, 'kommo_response_error', {
    status: res.status, url, attempt, retriable, bodyPreview: preview(body, 600)
  });

  if (retriable && attempt < 3) {
    const delay = 300 * (attempt + 1);
    await sleep(delay);
    return kommoFetch(ctx, path, init, attempt + 1);
  }

  // Propagamos error con detalle
  throw new Error(`${path} ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
}

/** ====== Acciones Kommo (con logs) ====== */
async function addLeadNote(ctx: string, leadId: number, text: string) {
  const payload = [{ entity_id: leadId, note_type: 'common', params: { text } }];
  const res = await kommoFetch(`${ctx}:add-note`, 'leads/notes', {
    method: 'POST', body: JSON.stringify(payload)
  });
  return res.json().catch(() => ({}));
}

async function findContact(ctx: string, query: string) {
  const res = await kommoFetch(`${ctx}:find-contact`,
    `contacts?query=${encodeURIComponent(query)}&with=leads&limit=1`,
    { method: 'GET' }
  );
  const d = await res.json().catch(() => ({}));
  const found = d?._embedded?.contacts?.[0] || null;
  log(ctx, 'find-contact_result', { query, found_id: found?.id || null });
  return found;
}

async function createContact(ctx: string, input: { name?: string; email?: string; phone?: string; }) {
  const { name, email, phone } = input;
  const cf: any[] = [];
  if (email) cf.push({ field_code: 'EMAIL', values: [{ value: email, enum_code: 'WORK' }] });
  if (phone) cf.push({ field_code: 'PHONE', values: [{ value: phone, enum_code: 'WORK' }] });

  const payload = [{
    name: name || email || phone || 'Contacto',
    custom_fields_values: cf.length ? cf : undefined
  }];

  const res = await kommoFetch(`${ctx}:create-contact`, 'contacts', {
    method: 'POST', body: JSON.stringify(payload)
  });
  const d = await res.json().catch(() => ({}));
  const contact = d?._embedded?.contacts?.[0];
  if (!contact?.id) throw new Error('createContact: response without id');
  log(ctx, 'create-contact_ok', { id: contact.id });
  return contact;
}

async function upsertContact(ctx: string, input: { name?: string; email?: string; phone?: string; }) {
  let c = null;
  if (input.email) c = await findContact(ctx, input.email);
  if (!c && input.phone) c = await findContact(ctx, input.phone);
  if (!c && input.name)  c = await findContact(ctx, input.name);
  if (c) {
    log(ctx, 'upsert-contact_hit', { id: c.id });
    return c;
  }
  return createContact(ctx, input);
}

type UpsertLeadInput = {
  name?: string; email?: string; phone?: string; price?: number;
  pipeline_id?: number; status_id?: number; tags?: string[];
  source?: string; notes?: string; custom_fields?: Record<string, any>;
};

async function createLead(ctx: string, input: UpsertLeadInput, contactId?: number) {
  const { name, price, pipeline_id, status_id, tags, custom_fields, source } = input;

  const payload = [{
    name: name || 'Nuevo lead',
    price: typeof price === 'number' ? price : undefined,
    pipeline_id,
    status_id,
    tags: Array.isArray(tags) ? tags.map((t) => ({ name: String(t) })) : undefined,
    custom_fields_values: custom_fields
      ? Object.entries(custom_fields).map(([code, value]) => ({
          field_code: code, values: [{ value }],
        }))
      : undefined,
    _embedded: contactId ? { contacts: [{ id: contactId }] } : undefined,
  }];

  const res = await kommoFetch(`${ctx}:create-lead`, 'leads', {
    method: 'POST', body: JSON.stringify(payload)
  });
  const d = await res.json().catch(() => ({}));
  const lead = d?._embedded?.leads?.[0];
  if (!lead?.id) throw new Error('createLead: response without id');

  if (source) {
    await addLeadNote(ctx, lead.id, `Origen: ${source}`);
  }
  log(ctx, 'create-lead_ok', { id: lead.id, contactId: contactId || null });
  return lead;
}

/** ====== Handlers de acciones ====== */
async function handleUpsert(ctx: string, body: any) {
  const input: UpsertLeadInput = body || {};
  const contact = await upsertContact(ctx, {
    name: input.name, email: input.email, phone: input.phone
  });
  const contactId = contact?.id ? Number(contact.id) : undefined;

  const lead = await createLead(ctx, input, contactId);
  if (input.notes) await addLeadNote(ctx, lead.id, input.notes);

  return { ok: true, lead_id: lead.id, contact_id: contactId };
}

async function handleAddNote(ctx: string, body: any) {
  const leadId = Number(body?.lead_id);
  const text = String(body?.text || '').trim();
  if (!leadId || !text) throw new Error('lead_id and text required');
  await addLeadNote(ctx, leadId, text);
  return { ok: true };
}

async function handleAttachTranscript(ctx: string, body: any) {
  const leadId = Number(body?.lead_id);
  const transcript: string = String(body?.transcript || '').trim();
  const title: string | undefined = body?.title;
  if (!leadId || !transcript) throw new Error('lead_id and transcript required');

  const header = `📎 Conversación completa${title ? ` — ${title}` : ''}\nFecha: ${new Date().toISOString()}`;
  await addLeadNote(ctx, leadId, header);

  // Troceo conservador + pausas para evitar 413/429
  let CHUNK = 1200;                 // tamaño inicial por fragmento
  const MAX_TRIES_PER_CHUNK = 2;    // reintentos por fragmento
  let sent = 0;

  for (let i = 0; i < transcript.length; i += CHUNK) {
    const slice = transcript.slice(i, i + CHUNK);
    let ok = false;

    for (let t = 0; t < MAX_TRIES_PER_CHUNK && !ok; t++) {
      try {
        log(ctx, 'attach-transcript_chunk_try', { indexStart: i, len: slice.length, try: t + 1, chunkSize: CHUNK });
        await addLeadNote(ctx, leadId, slice);
        ok = true;
        sent++;
      } catch (e: any) {
        const msg = String(e?.message || '');
        log(ctx, 'attach-transcript_chunk_error', { err: preview(msg, 300), indexStart: i, chunkSize: CHUNK });

        // Si fue 413 (payload grande), reducimos chunk y reintentamos
        if (msg.includes(' 413 ') && CHUNK > 600) {
          CHUNK = Math.max(600, Math.floor(CHUNK * 0.66));
        } else {
          // Backoff leve para 429/5xx
          await sleep(300);
        }
      }
    }

    if (!ok) throw new Error('attach-transcript failed after retries');

    await sleep(200); // pausa entre notas
  }

  log(ctx, 'attach-transcript_done', { fragments: sent, finalChunkSize: CHUNK });
  return { ok: true, chunks: sent };
}

/** ====== Auth del puente (Chat-AI -> HUB) ====== */
function authOk(req: VercelRequest) {
  const h = String(req.headers['x-bridge-secret'] || '');
  const q = String((req.query as any)?.secret || '');
  return BRIDGE_SECRET && (h === BRIDGE_SECRET || q === BRIDGE_SECRET);
}

/** ====== Handler principal ====== */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = `kommo:${randId()}`;

  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }
    if (!authOk(req)) {
      log(ctx, 'auth_failed', { reason: 'bridge secret mismatch' });
      return res.status(401).json({ error: 'unauthorized' });
    }

    const body = typeof req.body === 'object' ? req.body : JSON.parse(String(req.body || '{}'));
    const action = String(body?.action || (req.query as any)?.action || '').trim();

    log(ctx, 'request_received', { action, hasBody: !!body, baseUrl: kommoBase() });

    if (action === 'upsert')            return res.status(200).json(await handleUpsert(ctx, body));
    if (action === 'add-note')          return res.status(200).json(await handleAddNote(ctx, body));
    if (action === 'attach-transcript') return res.status(200).json(await handleAttachTranscript(ctx, body));

    return res.status(400).json({ error: 'unknown_action', hint: 'use action=upsert|add-note|attach-transcript' });
  } catch (e: any) {
    log(ctx, 'handler_error', { err: preview(e?.message || e, 800) });
    return res.status(500).json({ error: e?.message || 'server_error' });
  }
}
