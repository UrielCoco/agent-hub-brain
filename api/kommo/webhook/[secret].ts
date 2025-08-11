
// api/kommo/webhook/[secret].ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { WEBHOOK_SECRET } from '../../../src/config.js';
import { processWithAssistant } from '../../../src/services/openai.js';
import { postNoteToLead, getLatestMessageForLead } from '../../../src/services/kommo.js';
import { retry } from '../../../src/utils/retry.js';

type Any = Record<string, any>;
const mask = (s?: string) => !s ? '' : (s.length <= 8 ? '***' : `${s.slice(0,2)}***${s.slice(-4)}`);

export const config = { runtime: 'nodejs' };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const started = Date.now();
  try {
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Secret: del path (req.query.secret de Vercel) o ?secret=
    const pathSecret = String((req.query as Any).secret || '');
    const qsSecret   = String((req.query as Any).secret || '');
    if (WEBHOOK_SECRET && pathSecret !== WEBHOOK_SECRET && qsSecret !== WEBHOOK_SECRET) {
      console.warn('🚫 Secret inválido', { expected: mask(WEBHOOK_SECRET), got: mask(pathSecret || qsSecret) });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ua = String(req.headers['user-agent'] || '');
    const ct = String(req.headers['content-type'] || '');
    console.log('📩 KOMMO WEBHOOK HIT', {
      method, ua, ct,
      urlPath: req.url,
    });

    // Body puede venir como x-www-form-urlencoded (Kommo) o vacío
    const body = (req.body || {}) as Any;
    const q = (req.query || {}) as Any;

    // Intenta extraer leadId y texto desde todos los frentes
    const toNum = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const toStr = (v: any) => (v === undefined || v === null) ? '' : String(v).trim();

    // Del body (formatos típicos de Kommo)
    let leadId =
      toNum(body?.lead_id) ||
      toNum(body?.conversation?.lead_id) ||
      toNum(body?.leads?.[0]?.id) ||
      toNum(body['leads[add][0][id]']) ||
      toNum(q.lead_id);

    let text =
      toStr(body?.text) ||
      toStr(body?.message?.text) ||
      toStr(body?.data?.message?.text) ||
      toStr(q.text) ||
      '';

    // Si vino placeholder crudo, trátalo como vacío
    if (/^\s*\{\{.+\}\}\s*$/.test(text)) text = '';

    // Si aún no hay texto, intenta fallback rápido con last_message/fallback_text
    if (!text) {
      const fb = toStr(q.fallback_text) || toStr(body?.last_message?.text) || '';
      if (fb && !/^\s*\{\{.+\}\}\s*$/.test(fb)) text = fb;
    }

    // Si sigue sin texto, haz polling de Notas/mensajes 1–5s
    if (!text && leadId) {
      console.warn('⏳ Texto vacío: haré polling de notas ~5s…', { leadId });
      text = (await retry(() => getLatestMessageForLead(leadId), 6, 800)) || '';
    }

    if (!leadId) return res.status(400).json({ error: 'Missing lead_id' });
    if (!text) {
      console.warn('ℹ️ No text after polling; ack');
      return res.status(204).end();
    }

    // Llamar Assistant (sesión por lead)
    const result = await processWithAssistant({ text, leadId });

    // Postear nota con la respuesta
    if (result.text) {
      try {
        await postNoteToLead(leadId, result.text);
        console.log('📝 Nota creada', { leadId, len: result.text.length });
      } catch (e: any) {
        console.error('💥 postNoteToLead error:', e?.response?.data || e);
      }
    }

    console.log('✅ OK', {
      leadId,
      thread_id: result.threadId,
      run_status: result.runStatus,
      ms: Date.now() - started,
    });

    return res.status(200).json({
      ok: true,
      leadId,
      text_in: text,
      text_out: result.text,
      thread_id: result.threadId,
      run_status: result.runStatus,
    });
  } catch (err: any) {
    console.error('💥 webhook error:', err?.response?.data || err, { ms: Date.now() - started });
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
}