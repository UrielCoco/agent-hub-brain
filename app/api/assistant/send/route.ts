import { NextRequest, NextResponse } from 'next/server';
import { sendToAssistant } from '../../../lib/assistant';
import { addLeadNote } from '../../../lib/kommo';

export async function POST(req: NextRequest) {
  try {
    const { sessionId, text, leadId, channel } = await req.json();
    if (!sessionId || !text) return NextResponse.json({ error: 'sessionId y text requeridos' }, { status: 400 });

    const sessionKey = leadId ? `kommo:lead:${leadId}` : `web:${sessionId}`;
    const { text: answer, threadId } = await sendToAssistant(sessionKey, text);

    if (leadId) {
      const note = `(${channel ?? 'chat'})\n> Usuario: ${text}\n> Respuesta: ${answer}`;
      await addLeadNote(Number(leadId), note);
    }

    return NextResponse.json({ ok: true, thread_id: threadId, run_status: 'completed', text: answer, leadId: leadId ?? null });
  } catch (e:any) {
    return NextResponse.json({ error: e.message ?? 'Server error' }, { status: 500 });
  }
}
