// api/kommo.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * ====== ENV ======
 * - Usa token de larga duración (sin refresh).
 * - Configura UNO:
 *   - KOMMO_BASE_URL = https://<sub>.kommo.com  (o .amocrm.com si aplica)
 *   - KOMMO_SUBDOMAIN = <sub>
 * - Requerido:
 *   - KOMMO_ACCESS_TOKEN
 *   - WEBHOOK_SECRET  (debe coincidir con HUB_BRIDGE_SECRET en chat-ai)
 */
const KOMMO_BASE_URL = (process.env.KOMMO_BASE_URL || '').trim();
const KOMMO_SUBDOMAIN = (process.env.KOMMO_SUBDOMAIN || '').trim();
const KOMMO_ACCESS_TOKEN = (process.env.KOMMO_ACCESS_TOKEN || '').trim();
const BRIDGE_SECRET = (process.env.WEBHOOK_SECRET || '').trim();

/** ====== Utils & logging ====== */
function nowISO() { return new Date().toISOString(); }
function rid() { return Math.random().toString(36).slice(2, 10); }
function preview(x: any, max = 300) {
  const s = typeof x === 'string' ? x : JSON.stringify(x);
  return s.length > max ? s.slice(0, max) + `… (${s.length} chars)` : s;
}
function log(ctx: string, msg: string, data?: any) {
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

/** ====== Headers ====== */
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
  const headers = { ...authHeaders(), ...(init.headers || {}) } as Record<string,string>;
  const bodyPreview = init.body ? preview(init.body, 400) : undefined;
  log(ctx, 'kommo_request', { method: init.method || 'GET', url, attempt, bodyPreview });

  const res = await fetch(url, { ...init, headers });
  const text = await res.text().catch(() => '');
  const isJson = text.startsWith('{') || text.startsWith('[');
  const body = isJson ? (() => { try { return JSON.parse(text); } catch { return text; } })() : text;

  if (res.ok) {
    log(ctx, 'kommo_response_ok', { status: res.status, url, bodyPreview: preview(body, 400) });
    return new Response(isJson ? JSON.stringify(body) : String(body), {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') || 'application/json' }
    });
  }

  const retriable = res.status === 429 || res.status >= 500;
  log(ctx, 'kommo_response_error', { status: res.status, url, attempt, retriable, bodyPreview: preview(body, 600) });

  if (retriable && attempt < 3) {
    const delay = 300 * (attempt + 1);
    await sleep(delay);
    return kommoFetch(ctx, path, init, attempt + 1);
  }

  throw new Error(`${path} ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
}

/** ====== Helpers Kommo ====== */
async function addLeadNote(ctx: string, leadId: number, text: string) {
  const payload = [{ entity_id: leadId, note_type: 'common', params: { text } }];
  const res = await kommoFetch(`${ctx}:add-note`, 'leads/notes', { method: 'POST', body: JSON.stringify(payload) });
  return res.json().catch(() => ({}));
}

async function getLead(ctx: string, id: number) {
  const res = await kommoFetch(`${ctx}:get-lead`, `leads/${id}?with=contacts`, { method: 'GET' });
  const d = await res.json().catch(() => ({}));
  log(ctx, 'get-lead_result', { id, contacts: d?._embedded?.contacts?.length || 0 });
  return d;
}

async function updateLead(ctx: string, id: number, patch: any) {
  const payload = [{ id, ...patch }];
  const res = await kommoFetch(`${ctx}:update-lead`, 'leads', { method: 'PATCH', body: JSON.stringify(payload) });
  const d = await res.json().catch(() => ({}));
  log(ctx, 'update-lead_ok', { id, patchPreview: preview(patch) });
  return d;
}

async function findContactByQuery(ctx: string, query: string) {
  const res = await kommoFetch(`${ctx}:find-contact`,
    `contacts?query=${encodeURIComponent(query)}&with=leads&limit=1`,
    { method: 'GET' }
  );
  const d = await res.json().catch(() => ({}));
  const contact = d?._embedded?.contacts?.[0] || null;
  log(ctx, 'find-contact_result', { query, found_id: contact?.id || null });
  return contact;
}

async function getContactById(ctx: string, id: number) {
  const res = await kommoFetch(`${ctx}:get-contact`, `contacts/${id}?with=leads`, { method: 'GET' });
  const d = await res.json().catch(() => ({}));
  log(ctx, 'get-contact_result', { id, leads_count: d?._embedded?.leads?.length || 0 });
  return d || null;
}

function buildCF({ email, phone }: { email?: string; phone?: string }) {
  const cf: any[] = [];
  if (email) cf.push({ field_code: 'EMAIL', values: [{ value: email, enum_code: 'WORK' }] });
  if (phone) cf.push({ field_code: 'PHONE', values: [{ value: phone, enum_code: 'WORK' }] });
  return cf;
}

async function createContact(ctx: string, input: { name?: string; email?: string; phone?: string; }) {
  const payload = [{
    name: input.name || input.email || input.phone || 'Contacto',
    custom_fields_values: (() => {
      const cf = buildCF({ email: input.email, phone: input.phone });
      return cf.length ? cf : undefined;
    })(),
  }];
  const res = await kommoFetch(`${ctx}:create-contact`, 'contacts', { method: 'POST', body: JSON.stringify(payload) });
  const d = await res.json().catch(() => ({}));
  const contact = d?._embedded?.contacts?.[0];
  if (!contact?.id) throw new Error('createContact: response without id');
  log(ctx, 'create-contact_ok', { id: contact.id });
  return contact;
}

async function updateContact(ctx: string, id: number, input: { name?: string; email?: string; phone?: string }) {
  const payload: any = [{
    id,
    ...(input.name ? { name: input.name } : {}),
  }];

  const cf = buildCF({ email: input.email, phone: input.phone });
  if (cf.length) payload[0].custom_fields_values = cf;

  const res = await kommoFetch(`${ctx}:update-contact`, 'contacts', { method: 'PATCH', body: JSON.stringify(payload) });
  const d = await res.json().catch(() => ({}));
  log(ctx, 'update-contact_ok', { id, fields: Object.keys(input).filter(k => (input as any)[k]) });
  return d;
}

/** ====== Acciones ====== */

/** 1) Crear LEAD (sin contacto) */
type CreateLeadInput = {
  name?: string; price?: number; pipeline_id?: number; status_id?: number;
  tags?: string[]; source?: string; notes?: string; custom_fields?: Record<string, any>;
};
async function handleCreateLead(ctx: string, body: any) {
  const input: CreateLeadInput = body || {};

  // Sanitiza IDs: solo incluye si son > 0 (Kommo rechaza 0)
  const pipelineId =
    Number.isFinite(input.pipeline_id) && Number(input.pipeline_id) > 0
      ? Number(input.pipeline_id)
      : undefined;
  const statusId =
    Number.isFinite(input.status_id) && Number(input.status_id) > 0
      ? Number(input.status_id)
      : undefined;

  if (input.pipeline_id && !pipelineId) {
    log(ctx, 'create-lead_sanitize', { dropped: 'pipeline_id', value: input.pipeline_id });
  }
  if (input.status_id && !statusId) {
    log(ctx, 'create-lead_sanitize', { dropped: 'status_id', value: input.status_id });
  }

  const payload = [{
    name: input.name || 'Nuevo lead',
    price: typeof input.price === 'number' ? input.price : undefined,
    pipeline_id: pipelineId,
    status_id: statusId,
    tags: Array.isArray(input.tags) && input.tags.length
      ? input.tags.map((t) => ({ name: String(t) }))
      : undefined,
    custom_fields_values: input.custom_fields
      ? Object.entries(input.custom_fields).map(([code, value]) => ({ field_code: code, values: [{ value }] }))
      : undefined,
  }];

  const res = await kommoFetch(`${ctx}:create-lead`, 'leads', { method: 'POST', body: JSON.stringify(payload) });
  const d = await res.json().catch(() => ({}));
  const lead = d?._embedded?.leads?.[0];
  if (!lead?.id) throw new Error('createLead: response without id');

  if (input.source) await addLeadNote(ctx, lead.id, `Origen: ${input.source}`);
  if (input.notes)  await addLeadNote(ctx, lead.id, input.notes);

  log(ctx, 'create-lead_ok', { id: lead.id });
  return { ok: true, lead_id: lead.id };
}

/** 2) Actualizar LEAD (precio, etapa, tags, custom) */
async function handleUpdateLead(ctx: string, body: any) {
  const id = Number(body?.lead_id);
  if (!Number.isFinite(id) || id <= 0) throw new Error('lead_id required');

  const patch: any = {};
  if (typeof body?.price === 'number') patch.price = body.price;

  if (Number.isFinite(body?.pipeline_id) && Number(body.pipeline_id) > 0) {
    patch.pipeline_id = Number(body.pipeline_id);
  } else if (body?.pipeline_id !== undefined) {
    log(ctx, 'update-lead_sanitize', { dropped: 'pipeline_id', value: body.pipeline_id });
  }

  if (Number.isFinite(body?.status_id) && Number(body.status_id) > 0) {
    patch.status_id = Number(body.status_id);
  } else if (body?.status_id !== undefined) {
    log(ctx, 'update-lead_sanitize', { dropped: 'status_id', value: body.status_id });
  }

  if (Array.isArray(body?.tags)) {
    const tags = body.tags.map((t: any) => ({ name: String(t) })).filter((t: any) => t.name.trim().length);
    if (tags.length) patch.tags = tags;
  }

  if (body?.custom_fields) {
    patch.custom_fields_values = Object.entries(body.custom_fields).map(([code, value]) => ({
      field_code: code, values: [{ value }]
    }));
  }

  await updateLead(ctx, id, patch);
  if (body?.notes) await addLeadNote(ctx, id, String(body.notes));
  return { ok: true, lead_id: id };
}

/** 3) Crear/Actualizar CONTACTO y vincularlo al LEAD */
async function handleAttachContact(ctx: string, body: any) {
  const leadId = Number(body?.lead_id);
  if (!Number.isFinite(leadId) || leadId <= 0) throw new Error('lead_id required');

  const name  = body?.name  ? String(body.name)  : undefined;
  const email = body?.email ? String(body.email) : undefined;
  const phone = body?.phone ? String(body.phone) : undefined;

  if (!name && !email && !phone) throw new Error('provide name/email/phone');

  const lead = await getLead(ctx, leadId);
  let contactId: number | null = lead?._embedded?.contacts?.[0]?.id ? Number(lead._embedded.contacts[0].id) : null;

  if (!contactId && (email || phone)) {
    const found = await findContactByQuery(ctx, email || phone!);
    if (found?.id) contactId = Number(found.id);
  }

  if (!contactId) {
    const c = await createContact(ctx, { name, email, phone });
    contactId = Number(c.id);
  } else {
    await updateContact(ctx, contactId, { name, email, phone });
  }

  await updateLead(ctx, leadId, { _embedded: { contacts: [{ id: contactId }] } });

  if (body?.notes) await addLeadNote(ctx, leadId, String(body.notes));

  log(ctx, 'attach-contact_done', { leadId, contactId });
  return { ok: true, lead_id: leadId, contact_id: contactId };
}

/** 4) Agregar NOTA */
async function handleAddNote(ctx: string, body: any) {
  const leadId = Number(body?.lead_id);
  const text = String(body?.text || '').trim();
  if (!leadId || !text) throw new Error('lead_id and text required');
  await addLeadNote(ctx, leadId, text);
  return { ok: true, lead_id: leadId };
}

/** 5) Adjuntar TRANSCRIPT (troceado) */
async function handleAttachTranscript(ctx: string, body: any) {
  const leadId = Number(body?.lead_id);
  const transcript: string = String(body?.transcript || '').trim();
  const title: string | undefined = body?.title;
  if (!leadId || !transcript) throw new Error('lead_id and transcript required');

  const header = `📎 Conversación completa${title ? ` — ${title}` : ''}\nFecha: ${new Date().toISOString()}`;
  await addLeadNote(ctx, leadId, header);

  let CHUNK = 1200;
  const MAX_TRIES_PER_CHUNK = 2;
  let sent = 0;

  for (let i = 0; i < transcript.length; i += CHUNK) {
    const slice = transcript.slice(i, i + CHUNK);
    let ok = false;

    for (let t = 0; t < MAX_TRIES_PER_CHUNK && !ok; t++) {
      try {
        log(ctx, 'attach-transcript_chunk_try', { indexStart: i, len: slice.length, try: t + 1, chunkSize: CHUNK, leadId });
        await addLeadNote(ctx, leadId, slice);
        ok = true;
        sent++;
      } catch (e: any) {
        const msg = String(e?.message || '');
        log(ctx, 'attach-transcript_chunk_error', { err: preview(msg, 300), indexStart: i, chunkSize: CHUNK, leadId });
        if (msg.includes(' 413 ') && CHUNK > 600) {
          CHUNK = Math.max(600, Math.floor(CHUNK * 0.66));
        } else {
          await sleep(300);
        }
      }
    }

    if (!ok) throw new Error('attach-transcript failed after retries');
    await sleep(200);
  }

  log(ctx, 'attach-transcript_done', { fragments: sent, finalChunkSize: CHUNK, leadId });
  return { ok: true, lead_id: leadId, chunks: sent };
}

/** ====== Auth puente ====== */
function authOk(req: VercelRequest) {
  const h = String(req.headers['x-bridge-secret'] || '');
  const q = String((req.query as any)?.secret || '');
  return BRIDGE_SECRET && (h === BRIDGE_SECRET || q === BRIDGE_SECRET);
}

/** ====== Handler principal (router) ====== */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = `kommo:${rid()}`;
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    if (!authOk(req)) {
      log(ctx, 'auth_failed', { reason: 'bridge secret mismatch' });
      return res.status(401).json({ error: 'unauthorized' });
    }

    const body = typeof req.body === 'object' ? req.body : JSON.parse(String(req.body || '{}'));
    const action = String(body?.action || (req.query as any)?.action || '').trim();
    log(ctx, 'request_received', { action, hasBody: !!body, baseUrl: kommoBase() });

    if (action === 'create-lead')       return res.status(200).json(await handleCreateLead(ctx, body));
    if (action === 'update-lead')       return res.status(200).json(await handleUpdateLead(ctx, body));
    if (action === 'attach-contact')    return res.status(200).json(await handleAttachContact(ctx, body));
    if (action === 'add-note')          return res.status(200).json(await handleAddNote(ctx, body));
    if (action === 'attach-transcript') return res.status(200).json(await handleAttachTranscript(ctx, body));

    return res.status(400).json({ error: 'unknown_action', hint: 'use action=create-lead|update-lead|attach-contact|add-note|attach-transcript' });
  } catch (e: any) {
    log(ctx, 'handler_error', { err: preview(e?.message || e, 800) });
    return res.status(500).json({ error: e?.message || 'server_error' });
  }
}
