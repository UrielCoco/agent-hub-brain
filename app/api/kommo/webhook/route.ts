import { NextRequest, NextResponse } from 'next/server';
import { sendToAssistant } from '@/app/lib/assistant';
import { addLeadNote } from '@/app/lib/kommo';

function verifySecret(req: NextRequest) {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) return { ok: true, from: 'no-secret-configured' as const };

  const header = req.headers.get('x-webhook-secret');
  if (header && header === expected) return { ok: true, from: 'header' as const };

  const q = req.nextUrl.searchParams.get('secret');
  if (q && q === expected) return { ok: true, from: 'query' as const };

  
  return { ok: false as const, reason: 'mismatch' as const };
}

async function readBody(req: NextRequest) {
  const ctype = req.headers.get('content-type') || '';
  if (ctype.includes('application/json')) return await req.json().catch(()=> ({}));
  if (ctype.includes('application/x-www-form-urlencoded')) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    const obj: Record<string, any> = {};
    params.forEach((v,k)=> obj[k]=v);
    return obj;
  }
  return await req.json().catch(()=> ({}));
}

export async function POST(req: NextRequest) {
  try {
    const ver = verifySecret(req);
    if (!ver.ok) return NextResponse.json({ error: 'unauthorized', hint: 'secret por ?secret= o header x-webhook-secret' }, { status: 401 });

    const body = await readBody(req);
    const text: string = body?.text ?? body?.message ?? '';
    const leadIdRaw = body?.lead_id ?? body?.leadId;
    const leadId: number | undefined = leadIdRaw ? Number(leadIdRaw) : undefined;

    if (!text || !leadId) return NextResponse.json({ error: 'text y lead_id requeridos' }, { status: 400 });

    const sessionId = `kommo:lead:${leadId}`;
    const { text: answer } = await sendToAssistant(sessionId, text);
    await addLeadNote(leadId, `(kommo webhook)\n> Usuario: ${text}\n> Respuesta: ${answer}`);

    return NextResponse.json({ ok: true, via: ver.from });
  } catch (e:any) {
    return NextResponse.json({ error: e.message ?? 'Server error' }, { status: 500 });
  }
}
