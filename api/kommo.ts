import type { NextApiRequest, NextApiResponse } from 'next';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || process.env.HUB_BRIDGE_SECRET || '';
const KOMMO_BASE_URL =
  process.env.KOMMO_BASE_URL ||
  (process.env.KOMMO_SUBDOMAIN ? `https://${process.env.KOMMO_SUBDOMAIN}.kommo.com` : '');
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN || '';

const EMAIL_FIELD_ID = process.env.KOMMO_EMAIL_FIELD_ID ? Number(process.env.KOMMO_EMAIL_FIELD_ID) : undefined;
const PHONE_FIELD_ID = process.env.KOMMO_PHONE_FIELD_ID ? Number(process.env.KOMMO_PHONE_FIELD_ID) : undefined;

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

  const mustId = (v: any, name: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid_${name}: ${v}`);
    return n;
  };

  try {
    // ---------- CREATE LEAD ----------
    if (action === 'create-lead') {
      const name = payload?.name || 'Nuevo lead';
      const price = Number.isFinite(Number(payload?.price)) ? Number(payload.price) : 0;
      const notes = (payload?.notes ? String(payload.notes) : '').trim();
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

    // ---------- UPDATE LEAD ----------
    if (action === 'update-lead') {
      const leadId = mustId(payload?.lead_id, 'lead_id');
      const patch: any = {};
      if (Number.isFinite(Number(payload?.price))) patch.price = Number(payload.price);

      const { status, json } = await fetchKommo('/api/v4/leads', {
        method: 'PATCH',
        body: JSON.stringify([{ id: leadId, ...patch }]),
      });
      console.log('kommo:update-lead status=', status, 'body=', safeBody(json));

      if (status >= 200 && status < 300) {
        return { http: 200, json: { ok: true, data: { lead_id: leadId } } };
      }
      return { http: status, json: { ok: false, error: 'kommo update-lead failed', detail: json } };
    }

    // ---------- ATTACH CONTACT ----------
    if (action === 'attach-contact') {
      const leadId = mustId(payload?.lead_id, 'lead_id');
      const name = String(payload?.name || '').trim() || 'Contacto';
      const email: string | null = payload?.email ? String(payload.email).toLowerCase() : null;
      const phoneRaw: string | null = payload?.phone ? String(payload.phone) : null;
      const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
      const notes: string | null = payload?.notes ? String(payload.notes) : null;

      // 1) crear contacto (con fallback a field_id si la cuenta no acepta field_code)
      const cfv: any[] = [];
      if (email) {
        cfv.push(
          EMAIL_FIELD_ID
            ? { field_id: EMAIL_FIELD_ID, values: [{ value: email }] }
            : { field_code: 'EMAIL', values: [{ value: email }] }
        );
      }
      if (phone) {
        cfv.push(
          PHONE_FIELD_ID
            ? { field_id: PHONE_FIELD_ID, values: [{ value: phone }] }
            : { field_code: 'PHONE', values: [{ value: phone }] }
        );
      }

      const contactBody: any = { name, ...(cfv.length ? { custom_fields_values: cfv } : {}) };

      const { status: cStatus, json: cJson } = await fetchKommo('/api/v4/contacts', {
        method: 'POST',
        body: JSON.stringify([contactBody]),
      });
      console.log('kommo:contact status=', cStatus, 'body=', safeBody(cJson));
      if (cStatus < 200 || cStatus >= 300) {
        return { http: cStatus, json: { ok: false, error: 'kommo contact failed', detail: cJson } };
      }
      const contactId = cJson?._embedded?.contacts?.[0]?.id;
      const cid = mustId(contactId, 'contact_id');

      // 2) vincular a lead — intento #1
      let { status: lStatus, json: lJson } = await fetchKommo(`/api/v4/leads/${leadId}/link`, {
        method: 'POST',
        body: JSON.stringify([{ to_entity_id: cid, to_entity_type: 'contacts' }]),
      });
      console.log('kommo:link[1] status=', lStatus, 'body=', safeBody(lJson));

      // Retry con formato global si 400
      if (lStatus === 400) {
        const retry = await fetchKommo(`/api/v4/links`, {
          method: 'POST',
          body: JSON.stringify([
            {
              from_entity_id: leadId,
              from_entity_type: 'leads',
              to_entity_id: cid,
              to_entity_type: 'contacts',
            },
          ]),
        });
        lStatus = retry.status;
        lJson = retry.json;
        console.log('kommo:link[2] status=', lStatus, 'body=', safeBody(lJson));
      }

      // 3) nota opcional
      if (notes) {
        await fetchKommo('/api/v4/leads/notes', {
          method: 'POST',
          body: JSON.stringify([{ entity_id: leadId, note_type: 'common', params: { text: notes } }]),
        }).catch(() => null);
      }

      if (lStatus >= 200 && lStatus < 300) {
        return { http: 200, json: { ok: true, data: { lead_id: leadId, contact_id: cid } } };
      }
      return { http: lStatus, json: { ok: false, error: 'kommo link failed', detail: lJson } };
    }

    // ---------- ADD NOTE ----------
    if (action === 'add-note') {
      const leadId = mustId(payload?.lead_id, 'lead_id');
      const text = String(payload?.text || '').trim();
      if (!text) return { http: 400, json: { ok: false, error: 'empty_note' } };

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

    // ---------- ATTACH TRANSCRIPT ----------
    if (action === 'attach-transcript') {
      const leadId = mustId(payload?.lead_id, 'lead_id');
      const transcript: string = String(payload?.transcript || '').trim();
      if (!transcript) return { http: 200, json: { ok: true, data: { lead_id: leadId } } };

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

// ===== Helpers =====
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
function normalizePhone(phone: string): string {
  const p = phone.replace(/[^\d+]/g, '');
  if (!p.startsWith('+') && /^\d+$/.test(p)) return `+${p}`;
  return p;
}
