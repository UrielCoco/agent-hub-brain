import type { NextApiRequest, NextApiResponse } from 'next';

type SalesbotResponse = {
  status: 'success' | 'fail';
  reply?: string;
  error?: string;
  execute_handlers?: Array<{ handler: string; params: any }>;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<SalesbotResponse>) {
  console.log('📩 KOMMO HIT', {
    method: req.method,
    url: req.url,
    ct: req.headers['content-type'],
    ua: req.headers['user-agent'],
  });

  // 1) Secret
  const secret = (req.query?.secret || '').toString();
  if (secret !== process.env.KOMMO_SECRET) {
    console.warn('❌ Forbidden: bad secret', { got: secret ? '***' : '(empty)' });
    return res.status(403).json({ status: 'fail', error: 'forbidden' });
  }

  // 2) Parse body (JSON o x-www-form-urlencoded)
  const ct = (req.headers['content-type'] || '').toLowerCase();
  let body: any = req.body ?? {};
  try {
    if (typeof body === 'string') {
      if (ct.includes('application/json')) body = JSON.parse(body);
      else if (ct.includes('application/x-www-form-urlencoded')) {
        body = Object.fromEntries(new URLSearchParams(body));
      }
    } else if (!body || Object.keys(body).length === 0) {
      // fallback por si el body parser no actuó
      // @ts-ignore
      const raw = (req as any).rawBody?.toString?.() || '';
      if (raw) {
        if (ct.includes('application/json')) body = JSON.parse(raw);
        else if (ct.includes('application/x-www-form-urlencoded')) {
          body = Object.fromEntries(new URLSearchParams(raw));
        }
      }
    }
  } catch (e) {
    console.error('💥 Parse error', e);
  }

  const message = body?.message || body?.message_text || '';
  const leadId  = body?.lead_id || body?.leadId || '';
  console.log('🧾 Parsed payload', { message, leadId, rawKeys: Object.keys(body || {}) });

  // 3) Aquí llamarías a tu Assistant; por ahora hacemos un reply básico
  const reply = message ? `Echo: ${message}` : 'Hola 👋 ¿en qué te ayudo?';

  // 4) Respuesta para Salesbot (nivel superior: status)
  const out: SalesbotResponse = {
    status: 'success',
    reply,
    execute_handlers: [
      { handler: 'show', params: { type: 'text', value: reply } },
    ],
  };

  console.log('✅ Responding', out);
  return res.status(200).json(out);
}
