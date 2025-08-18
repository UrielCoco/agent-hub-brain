import type { NextApiRequest, NextApiResponse } from 'next';

const KOMMO_BASE_URL = (process.env.KOMMO_BASE_URL || '').trim();
const KOMMO_SUBDOMAIN = (process.env.KOMMO_SUBDOMAIN || '').trim();
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN || '';
const BRIDGE_SECRET = process.env.WEBHOOK_SECRET || '';

function kommoBase() { if (KOMMO_BASE_URL) return KOMMO_BASE_URL.replace(/\/+$/,''); if (KOMMO_SUBDOMAIN) return `https://${KOMMO_SUBDOMAIN}.kommo.com`; throw new Error('KOMMO_BASE_URL or KOMMO_SUBDOMAIN missing'); }
function apiV4(p: string) { return `${kommoBase()}/api/v4/${p.replace(/^\/+/, '')}`; }
function hdrs() { return { Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }; }
function authOk(req: NextApiRequest) { const h=String(req.headers['x-bridge-secret']||''); const q=String((req.query as any)?.secret||''); return BRIDGE_SECRET&&(h===BRIDGE_SECRET||q===BRIDGE_SECRET); }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    const body = typeof req.body === 'object' ? req.body : JSON.parse(String(req.body || '{}'));
    const leadId = Number(body?.lead_id); const text = String(body?.text || '').trim();
    if (!leadId || !text) return res.status(400).json({ error: 'lead_id and text required' });

    const payload = [{ entity_id: leadId, note_type: 'common', params: { text } }];
    const r = await fetch(apiV4('leads/notes'), { method: 'POST', headers: hdrs(), body: JSON.stringify(payload) });
    if (!r.ok) throw new Error(`add-note ${r.status}: ${await r.text()}`);

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'server_error' });
  }
}
