// /api/kommo/salesbot-entry.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

function timingSafeEq(a: string, b: string) {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function ok(res: VercelResponse, reply: string) {
  return res.status(200).json({
    status: 'success',
    reply,
    execute_handlers: [
      { handler: 'show', params: { type: 'text', value: reply } }
    ]
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'fail', error: 'method_not_allowed' });
  }

  console.log('📩 KOMMO HIT', {
    method: req.method,
    url: req.url,
    ct: req.headers['content-type'],
    ua: req.headers['user-agent'],
    env: process.env.VERCEL_ENV || 'unknown'
  });

  // --- Secret por query (?secret=...) comparado con ENV WEBHOOK_SECRET ---
  const host = req.headers.host || 'localhost';
  const full = new URL(req.url || '/', `https://${host}`);
  const gotSecret = (full.searchParams.get('secret') || '').trim();
  const envSecret = (process.env.WEBHOOK_SECRET || '').trim();

  // Log de bordes (no revela el secreto completo)
  console.log('🔐 Secret debug', {
    got_len: gotSecret.length,
    env_len: envSecret.length,
    got_edge: gotSecret ? `${gotSecret.slice(0,4)}…${gotSecret.slice(-4)}` : '(empty)',
    env_edge: envSecret ? `${envSecret.slice(0,4)}…${envSecret.slice(-4)}` : '(empty)'
  });

  if (!envSecret || !gotSecret || !timingSafeEq(gotSecret, envSecret)) {
    console.warn('❌ Forbidden: secret mismatch');
    return res.status(403).json({ status: 'fail', error: 'forbidden' });
  }

  // --- Parseo del cuerpo (JSON o x-www-form-urlencoded) ---
  const ct = (req.headers['content-type'] || '').toLowerCase();
  let body: any = req.body ?? {};

  // a) Si el body llegó como string, parsea según content-type
  if (typeof body === 'string') {
    try {
      if (ct.includes('application/json'))      body = JSON.parse(body);
      else if (ct.includes('application/x-www-form-urlencoded'))
        body = Object.fromEntries(new URLSearchParams(body));
    } catch (e) {
      console.error('💥 Parse error (string body)', e);
    }
  }

  // b) Fallback: si no hay body, intenta leer el raw stream (algunos runtimes)
  if (!body || Object.keys(body).length === 0) {
    const raw = await new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
      req.on('error', () => resolve(''));
    });
    try {
      if (raw) {
        if (ct.includes('application/json'))      body = JSON.parse(raw);
        else if (ct.includes('application/x-www-form-urlencoded'))
          body = Object.fromEntries(new URLSearchParams(raw));
      }
    } catch (e) {
      console.error('💥 Parse error (raw body)', e);
    }
  }

  const message = body?.message ?? body?.message_text ?? '';
  const leadId  = body?.lead_id ?? body?.leadId ?? '';
  console.log('🧾 Parsed payload', { message, leadId, keys: Object.keys(body || {}) });

  // 👉 Aquí puedes llamar a tu Assistant real; por ahora, eco:
  const reply = message ? `Echo: ${message}` : 'Hola 👋 ¿en qué te ayudo?';

  console.log('✅ Responding success');
  return ok(res, reply);
}
