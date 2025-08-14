// agent-hub-brain-main/api/kommo/global.ts
// Webhook Global de Kommo (form-urlencoded). Sólo log/ack; NO empuja mensajes al chat.

import type { VercelRequest, VercelResponse } from "@vercel/node";

export const config = { api: { bodyParser: false } };

function parseFormEncoded(buf: Buffer) {
  const params = new URLSearchParams(buf.toString("utf-8"));
  const obj: Record<string, any> = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const ct = String(req.headers["content-type"] || "");
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    const raw = Buffer.concat(chunks);

    const payload =
      /application\/x-www-form-urlencoded/i.test(ct) ? parseFormEncoded(raw) : {};

    console.log("[GLOBAL v4] meta", { ct });
    console.log("[GLOBAL v4] keys", Object.keys(payload || {}));

    // Importante: NO /api/v4/chats/messages aquí.
    if (!res.writableEnded) {
      res.status(200).json({ ok: true });
    }
  } catch (e: any) {
    console.error("[GLOBAL v4] fatal", e?.message || e);
    if (!res.writableEnded) res.status(200).json({ ok: true });
  }
}
