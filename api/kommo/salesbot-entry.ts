// api/kommo/salesbot-entry.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAssistantReply } from '../_lib/assistant';
import { addLeadNote } from '../_lib/kommo';

const BRIDGE_SECRET = process.env.WEBHOOK_SECRET || '';
const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN || '';
const KOMMO_INTEGRATION_ID = process.env.KOMMO_INTEGRATION_ID || '';

function authOk(req: VercelRequest) {
  const h = String(req.headers['x-bridge-secret'] || '');
  const q = String((req.query as any)?.secret || '');
  return BRIDGE_SECRET && (h === BRIDGE_SECRET || q === BRIDGE_SECRET);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(String(req.body || '{}'));

    // Campos típicos que envía Kommo / Salesbot
    const message: string = String(
      body?.message ?? body?.text ?? body?.question ?? ''
    ).trim();

    const leadId: number | undefined =
      body?.lead_id ? Number(body.lead_id) :
      body?.leadId  ? Number(body.leadId)  :
      undefined;

    if (!message) return res.status(400).json({ error: 'empty_message' });

    // ⬇️ SOLO props que el tipo de getAssistantReply acepta (evitamos 'threadId')
    const reply: string = await getAssistantReply(message, {
      subdomain: KOMMO_SUBDOMAIN || undefined,
      integration_id: KOMMO_INTEGRATION_ID || undefined,
      // Si tu tipo admite otras props, agrégalas aquí (p. ej., language, persona, etc.)
    } as any); // <- 'as any' por si el tipo es más estricto entre versiones

    // Opcional: registra ida/vuelta en el lead
    if (leadId) {
      await addLeadNote(
        leadId,
        `Salesbot preguntó:\n${message}\n\nAssistant respondió:\n${reply}`
      );
    }

    return res.status(200).json({ ok: true, reply });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'server_error' });
  }
}
