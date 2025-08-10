import OpenAI from "openai";
import { OPENAI_API_KEY, OPENAI_ASSISTANT_ID } from "../config.js";
import { getThreadId, setThreadId } from "../store/thread-store.js";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function sessionKey({ sessionId, leadId }: { sessionId?: string; leadId?: number }) {
  if (leadId) return `kommo:lead:${leadId}`;
  if (sessionId) return `web:${sessionId}`;
  return `anon:${Math.random().toString(36).slice(2)}`;
}

export async function processWithAssistant(opts: {
  text: string;
  sessionId?: string;
  leadId?: number;
}) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  if (!OPENAI_ASSISTANT_ID) throw new Error("Missing OPENAI_ASSISTANT_ID");

  const key = sessionKey({ sessionId: opts.sessionId, leadId: opts.leadId });

  // 1) Ensure thread
  let threadId = await getThreadId(key);
  if (!threadId) {
    const thread = await openai.beta.threads.create();
    threadId = thread.id;
    await setThreadId(key, threadId);
  }

  // 2) Add user message
  await openai.beta.threads.messages.create(threadId, {
    role: "user",
    content: opts.text,
  });

  // 3) Run
  const run = await openai.beta.threads.runs.create(threadId, {
    assistant_id: OPENAI_ASSISTANT_ID,
  });

  // 4) Poll
  let status = run.status;
  while (
    status !== "completed" &&
    status !== "requires_action" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "expired"
  ) {
    await new Promise((r) => setTimeout(r, 900));
    const current = await openai.beta.threads.runs.retrieve(threadId, run.id);
    status = current.status;
  }

  if (status === "requires_action") {
    // Aquí se podrían manejar tool-calls, si configuras herramientas en tu Assistant.
    // Por ahora devolvemos un mensaje informativo.
    return { threadId, runStatus: status, text: "El asistente requiere una acción (tool call). Implementa orquestación en el Hub.", key };
  }

  if (status !== "completed") {
    throw new Error(`Run status: ${status}`);
  }

  // 5) Read last assistant message
  const list = await openai.beta.threads.messages.list(threadId, { limit: 10 });
  const assistantMsg = list.data.find((m) => m.role === "assistant");
  const parts = assistantMsg?.content || [];
  const textPart: any = parts.find((p) => p.type === "text");
  const value = textPart?.text?.value?.trim() || "";

  return { threadId, runStatus: status, text: value, key };
}
