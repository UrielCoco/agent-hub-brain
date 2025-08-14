// /api/_lib/amojo.ts
import crypto from 'crypto';

const AMOJO_BASE = process.env.KOMMO_AMOJO_BASE || 'https://amojo.kommo.com';
const SCOPE_ID = process.env.KOMMO_SCOPE_ID || ''; // obtenido al conectar el canal
const CHANNEL_SECRET = process.env.KOMMO_CHANNEL_SECRET || '';

function rfc2822Date(d: Date = new Date()) { return d.toUTCString(); }
function md5Hex(data: string) { return crypto.createHash('md5').update(data, 'utf8').digest('hex'); }
function hmacSha1Hex(key: string, data: string) { return crypto.createHmac('sha1', key).update(data).digest('hex'); }

// Firma para requests salientes de Chats API
export function signOutgoing({ method, date, contentMd5, path }:{
  method: 'POST'|'GET'|'DELETE'; date: string; contentMd5: string; path: string;
}) {
  const str = [method, date, contentMd5, path].join('\n');
  return hmacSha1Hex(CHANNEL_SECRET, str);
}

// Verificación de webhooks entrantes de Chats API
export function verifyIncomingSignature(rawBody: string, xSignature?: string) {
  if (!CHANNEL_SECRET) return false;
  const expected = hmacSha1Hex(CHANNEL_SECRET, rawBody);
  return (xSignature || '').toLowerCase() === expected.toLowerCase();
}

export async function sendAmojoMessage(body: any, opts?: { scopeId?: string }) {
  const scopeId = opts?.scopeId || SCOPE_ID;
  if (!scopeId) throw new Error('KOMMO_SCOPE_ID is required');
  if (!CHANNEL_SECRET) throw new Error('KOMMO_CHANNEL_SECRET is required');

  const path = `/v2/origin/custom/${scopeId}`;
  const url = `${AMOJO_BASE}${path}`;
  const date = rfc2822Date();
  const json = JSON.stringify(body);
  const md5 = md5Hex(json);
  const sig = signOutgoing({ method: 'POST', date, contentMd5: md5, path });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Date': date,
      'Content-Type': 'application/json',
      'Content-MD5': md5,
      'X-Signature': sig,
      'Accept': 'application/json'
    },
    body: json,
    cache: 'no-store'
  });

  const text = await res.text().catch(()=> '');
  if (!res.ok) throw new Error(`amojo ${res.status}: ${text || res.statusText}`);
  try { return JSON.parse(text); } catch { return { ok: true, raw: text }; }
}
