import type { NextApiRequest, NextApiResponse } from 'next';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || process.env.HUB_BRIDGE_SECRET || '';
const KOMMO_BASE_URL =
  process.env.KOMMO_BASE_URL ||
  (process.env.KOMMO_SUBDOMAIN ? `https://${process.env.KOMMO_SUBDOMAIN}.kommo.com` : '');
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN || '';

type OkRes = { ok: true; data?: any };
type ErrRes = { ok: false; error: string; detail?: any };

export default async function handler(req: NextApiRequest, res: NextApiResponse<OkRes | ErrRes>) {
  try {
    const secret =
      (req.query?.secret as string) ||
      (req.headers['x-bridge-secret'] as string) ||
      (req.headers['x-webhook-secret'] as string) ||
      '';

    if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
      console.error('hub:kommo secret_mismatch');
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    if (!KOMMO_BASE_URL || !KOMMO_ACCESS_TOKEN) {
      console.error('hub:kommo missing_env');
      return res.status(500).json({ ok: false, error: 'missing kommo env' });
    }

    if (req.method !== 'POST') {
      return res.status(200).json({ ok: true, data: { pong: true } });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const action = body?.action as
      | 'create-lead'
      | 'update-lead'
      | 'attach-contact'
      | 'add-note'
      | 'attach-transcript';

    console.log('hub:kommo action=', action);

    const r = await routeKommoAction(action, body);
    return res.status(r.http || 200).json(r.json as any);
  } catch (e: any) {
    console.error('hub:kommo error', e?.stack || e);
    return res.status(500).json({ ok: false, error: 'exception', detail: String(e?.message || e) });
  }
}

async function routeKommoAction(action: string, payload: any): Promise<{ http: number; json: OkRes | ErrRes }> {
  const headers = {
    Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const fetchKommo = async (url: string, init?: RequestInit) => {
    const full = `${KOMMO_BASE_URL}${url}`;
    const resp = await fetch(full, { ...(init || {}), headers: { ...headers, ...(init?.headers || {}) } });
    const json = await resp.json().catch(() => ({}));
    return { status: resp.status, json };
  };

  try {
    if (action === 'create-lead') {
      const name = payload?.name || 'Nuevo lead';
      const price = payload?.price || 0;
      const notes = payload?.notes || '';
      const source = payload?.source || 'webchat';

      const { status, json } = await fetchKommo('/api/v4/leads', {
        method: 'POST',
        body: JSON.stringify([{ name, price, _embedded: { tags: [{ name: source }] } }]),
      });

      console.log('kommo:create-lead status=', status, 'body=', safeBody(json));
      if (status >= 200 && status < 300) {
        const leadId = json?._embedded?.leads?.[0]?.id;
        if (notes) {
          await fetchKommo('/api/v4/leads/notes', {
            method: 'POST',
            body: JSON.stringify([{ entity_id: leadId, note_type: 'common', params: { text: notes } }]),
          });
        }
        return { http: 200, json: { ok: true, data: { lead_id: leadId } } };
      }
      return { http: status, json: { ok: false, error: 'kommo create-lead failed', detail: json } };
    }

    if (action === 'update-lead') {
      const leadId = Number(payload?.lead_id);
      const price = payload?.price;
      const tags: string[] = payload?.tags || [];

      const patch: any = {};
      if (typeof price === 'number') patch.price = price;

      const { status, json } = await fetchKommo('/api/v4/leads', {
        method: 'PATCH',
        body: JSON.stringify([{ id: leadId, ...patch }]),
      });

      console.log('kommo:update-lead status=', status, 'body=', safeBody(json));
      if (status >= 200 && status < 300) {
        if (Array.isArray(tags) && tags.length) {
          // tagging simple (opcional)
          await fetchKommo(`/api/v4/leads/${leadId}/link`, {
            method: 'POST',
            body: JSON.stringify({ to_entity_id: leadId, to_entity_type: 'leads', metadata: { tags } }),
          }).catch(() => null);
        }
        return { http: 200, json: { ok: true, data: { lead_id: leadId } } };
      }
      return { http: status, json: { ok: false, error: 'kommo update-lead failed', detail: json } };
    }

    if (action === 'attach-contact') {
      const leadId = Number(payload?.lead_id);
      const name = String(payload?.name || '').trim() || 'Contacto';
      const email: string | null = payload?.email ? String(payload.email).toLowerCase() : null;
      const phone: string | null = payload?.phone ? String(payload.phone) : null;
      const notes: string | null = payload?.notes || null;

      // 1) crear contacto
      const contactBody: any = { name, custom_fields_values: [] as any[] };
      if (email) contactBody.custom_fields_values.push({ field_code: 'EMAIL', values: [{ value: email }] });
      if (phone) contactBody.custom_fields_values.push({ field_code: 'PHONE', values: [{ value: phone }] });

      const { status: cStatus, json: cJson } = await fetchKommo('/api/v4/contacts', {
        method: 'POST',
        body: JSON.stringify([contactBody]),
      });
      console.log('kommo:contact status=', cStatus, 'body=', safeBody(cJson));
      if (cStatus < 200 || cStatus >= 300) {
        return { http: cStatus, json: { ok: false, error: 'kommo contact failed', detail: cJson } };
      }
      const contactId = cJson?._embedded?.contacts?.[0]?.id;

      // 2) vincular a lead
      const { status: lStatus, json: lJson } = await fetchKommo(`/api/v4/leads/${leadId}/link`, {
        method: 'POST',
        body: JSON.stringify([{ to_entity_id: contactId, to_entity_type: 'contacts' }]),
      });
      console.log('kommo:link status=', lStatus, 'body=', safeBody(lJson));

      // 3) nota opcional
      if (notes) {
        await fetchKommo('/api/v4/leads/notes', {
          method: 'POST',
          body: JSON.stringify([{ entity_id: leadId, note_type: 'common', params: { text: notes } }]),
        }).catch(() => null);
      }

      if (lStatus >= 200 && lStatus < 300) {
        return { http: 200, json: { ok: true, data: { lead_id: leadId, contact_id: contactId } } };
      }
      return { http: lStatus, json: { ok: false, error: 'kommo link failed', detail: lJson } };
    }

    if (action === 'add-note') {
      const leadId = Number(payload?.lead_id);
      const text = String(payload?.text || '').slice(0, 15000);
      const { status, json } = await fetchKommo('/api/v4/leads/notes', {
        method: 'POST',
        body: JSON.stringify([{ entity_id: leadId, note_type: 'common', params: { text } }]),
      });
      console.log('kommo:add-note status=', status, 'body=', safeBody(json));
      if (status >= 200 && status < 300) {
        return { http: 200, json: { ok: true, data: { lead_id: leadId } } };
      }
      return { http: status, json: { ok: false, error: 'kommo add-note failed', detail: json } };
    }

    if (action === 'attach-transcript') {
      const leadId = Number(payload?.lead_id);
      const transcript: string = String(payload?.transcript || '');
      const chunks = chunk(transcript, 8000);
      for (let i = 0; i < chunks.length; i++) {
        const { status } = await fetchKommo('/api/v4/leads/notes', {
          method: 'POST',
          body: JSON.stringify([
            { entity_id: leadId, note_type: 'common', params: { text: `Transcripción (${i + 1}/${chunks.length}):\n\n${chunks[i]}` } },
          ]),
        });
        if (status < 200 || status >= 300) break;
      }
      return { http: 200, json: { ok: true, data: { lead_id: leadId } } };
    }

    return { http: 400, json: { ok: false, error: 'unknown action' } };
  } catch (e: any) {
    return { http: 500, json: { ok: false, error: 'exception', detail: String(e?.message || e) } };
  }
}

function chunk(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}
function safeBody(j: any) {
  try {
    const clone = JSON.parse(JSON.stringify(j || {}));
    if (clone?.access_token) clone.access_token = '***';
    return clone;
  } catch {
    return {};
  }
}
