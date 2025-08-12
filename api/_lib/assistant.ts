import OpenAI from 'openai';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID!;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Almacenamiento simple en memoria (prod: cambia a Redis/DB)
const mem = new Map<string, string>();

export async function sendToAssistant(sessionId: string, userText: string) {
  if (!OPENAI_ASSISTANT_ID) throw new Error('Falta OPENAI_ASSISTANT_ID');

  let threadId = mem.get(sessionId);
  if (!threadId) {
    const thr = await openai.beta.threads.create();
    threadId = thr.id;
    mem.set(sessionId, threadId);
  }

  await openai.beta.threads.messages.create(threadId, { role: 'user', content: userText });

  const run = await openai.beta.threads.runs.create(threadId, { assistant_id: OPENAI_ASSISTANT_ID });

  // Polling sencillo (sin tools)
  let status = run.status;
  while (status === 'queued' || status === 'in_progress') {
    const r = await openai.beta.threads.runs.retrieve(threadId, run.id);
    status = r.status;
    if (status === 'requires_action') throw new Error('Assistant requiere tools no implementadas');
    if (['failed', 'cancelled', 'expired'].includes(status)) throw new Error(`Run ${status}`);
    if (status !== 'completed') await new Promise(r => setTimeout(r, 600));
  }

  const msgs = await openai.beta.threads.messages.list(threadId, { limit: 5 });
  const last = msgs.data.find((m: any) => m.role === 'assistant');
  const text = (last?.content?.[0] as any)?.text?.value ?? '...';

  return { text, threadId };
}
