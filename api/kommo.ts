// api/kommo.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

const KOMMO_BASE_URL = (process.env.KOMMO_BASE_URL || '').trim();
const KOMMO_SUBDOMAIN = (process.env.KOMMO_SUBDOMAIN || '').trim();
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN || '';
const BRIDGE_SECRET = process.env.WEBHOOK_SECRET || '';

function kommoBase() {
  if (KOMMO_BASE_URL) return KOMMO_BASE_URL.replace(/\/+$/,'');
  if (KOMMO_SUBDOMAIN) return `https://${KOMMO_SUBDOMAIN}.kommo.com`;
  throw new Error('KOMMO_BASE_URL or KOMMO_SUBDOMAIN missing');
}
function apiV4(p: string) { return `${kommoBase()}/api/v4/${p.replace(/^\/+/, '')}`; }
function hdrs() { return { Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }; }
function authOk(req: VercelRequest) {
  const h = String(req.headers['x-bridge-secret'] || '');
  const q = String((req.query as any)?.secret || '');
  return BRIDGE_SECRET && (h === BRIDGE_SECRET || q === BRIDGE_SECRET);
}

async function addLeadNote(leadId: number, text: string) {
  const payload = [{ entity_id: leadId, note_type: 'common', params: { text } }];
  const r = await fetch(apiV4('leads/notes'), { method: 'POST', headers: hdrs(), body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`addLeadNote ${r.status}: ${await r.text()}`);
}

async function findContact(query: string) {
  const r = await fetch(apiV4(`contacts?query=${encodeURIComponent(query)}&with=leads&limit=1`), { headers: hdrs() });
  if (!r.ok) return null;
  const d = await r.json().catch(() => ({}));
  return d?._embedded?.contacts?.[0] || null;
}
async function createContact({ name, email, phone }:{ name?: string; email?: string; phone?: string; }) {
  const cf: any[] = [];
  if (email) cf.push({ field_code: 'EMAIL', values: [{ value: email, enum_code: 'WORK' }] });
  if (phone) cf.push({ field_code: 'PHONE', values: [{ value: phone, enum_code: 'WORK' }] });
  const payload = [{ name: name || email || phone || 'Contacto', custom_fields_values: cf.length ? cf : undefined }];
  const r = await fetch(apiV4('contacts'), { method: 'POST', headers: hdrs(), body: JSON.stringify(payload) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`createContact ${r.status}: ${JSON.stringify(d)}`);
  return d?._embedded?.contacts?.[0];
}
async function upsertContact({ name, email, phone }:{ name?: string; email?: string; phone?: string; }) {
  let c = null; if (email) c = await findContact(email);
  if (!c && phone) c = await findContact(phone);
  if (!c && name)  c = await findContact(name);
  if (!c) c = await createContact({ name, email, phone });
  return c;
}

type UpsertLeadInput = {
  name?: string; email?: string; phone?: string; price?: number;
  pipeline_id?: number; status_id?: number; tags?: string[];
  source?: string; notes?: string; custom_fields?: Record<string, any>;
};

async function createLead(input: UpsertLeadInput, contactId?: number) {
  const { name, price, pipeline_id, status_id, tags, custom_fields, source } = input;
  const payload = [{
    name: name || 'Nuevo lead',
    price: typeof price === 'number' ? price : undefined,
    pipeline_id, status_id,
    tags: Array.isArray(tags) ? tags.map((t) => ({ name: String(t) })) : undefined,
    custom_fields_values: custom_fields ? Object.entries(custom_fields).map(([code, value]) => ({
      field_code: code, values: [{ value }],
    })) : undefined,
    _embedded: contactId ? { contacts: [{ id: contactId }] } : undefined,
  }];

  const r = await fetch(apiV4('leads'), { method: 'POST', headers: hdrs(), body: JSON.stringify(payload) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`createLead ${r.status}: ${JSON.stringify(d)}`);
  const lead = d?._embedded?.leads?.[0]; if (!lead?.id) throw new Error('Lead not created');
  if (source) await addLeadNote(lead.id, `Origen: ${source}`);
  return lead;
}

async function handleUpsert(body: any) {
  const input: UpsertLeadInput = body || {};
  const contact = await upsertContact({ name: input.name, email: input.email, phone: input.phone });
  const contactId = contact?.id ? Number(contact.id) : undefined;
  const lead = await createLead(input, contactId);
  if (input.notes) await addLeadNote(lead.id, input.notes);
  return { ok: true, lead_id: lead.id, contact_id: contactId };
}

async function handleAddNote(body: any) {
  const leadId = Number(body?.lead_id); const text = String(body?.text || '').trim();
  if (!leadId || !text) throw new Error('lead_id and text required');
  await addLeadNote(leadId, text);
  return { ok: true };
}

async function handleAttachTranscript(body: any) {
  const leadId = Number(body?.lead_id);
  const transcript: string = String(body?.transcript || '').trim();
  const title: string | undefined = body?.title;
  if (!leadId || !transcript) throw new Error('lead_id and transcript required');
  const header = `📎 Conversación completa${title ? ` — ${title}` : ''}\nFecha: ${new Date().toISOString()}`;
  await addLeadNote(leadId, header);
  const CHUNK = 3500;
  for (let i = 0; i < transcript.length; i += CHUNK) {
    await addLeadNote(leadId, transcript.slice(i, i + CHUNK));
  }
  return { ok: true, chunks: Math.ceil(transcript.length / CHUNK) };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(String(req.body || '{}'));
    const action = String(body?.action || (req.query as any)?.action || '').trim();

    if (action === 'upsert')              return res.status(200).json(await handleUpsert(body));
    if (action === 'add-note')            return res.status(200).json(await handleAddNote(body));
    if (action === 'attach-transcript')   return res.status(200).json(await handleAttachTranscript(body));

    return res.status(400).json({ error: 'unknown_action', hint: 'use action=upsert|add-note|attach-transcript' });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'server_error' });
  }
}
