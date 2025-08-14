// api/kommo/global.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { mkLogger, genTraceId } from "../_lib/logger";

export const config = { api: { bodyParser: false } };

function parseFormEncoded(buf: Buffer) {
  const params = new URLSearchParams(buf.toString("utf-8"));
  const obj: Record<string, any> = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const traceId = (req.headers["x-trace-id"] as string) || genTraceId();
  const log = mkLogger(traceId);

  try {
    const ct = String(req.headers["content-type"] || "");
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    const raw = Buffer.concat(chunks);

    const payload = /application\/x-www-form-urlencoded/i.test(ct) ? parseFormEncoded(raw) : {};
    const keys = Object.keys(payload || {});
    log.info("[GLOBAL v4] meta", { ct, len: raw.length });
    log.info("[GLOBAL v4] keys", keys);

    // Extra rápida de campos comunes
    const chatId   = payload["message[add][0][chat_id]"];
    const talkId   = payload["message[add][0][talk_id]"];
    const text     = payload["message[add][0][text]"];
    const contact  = payload["message[add][0][contact_id]"];
    const entityId = payload["message[add][0][entity_id]"];
    const author   = payload["message[add][0][author][type]"];
    const type     = payload["message[add][0][type]"];

    log.info("[GLOBAL v4] extracted", {
      direction: type === "in" ? "incoming" : "outgoing",
      authorType: author,
      chatId, talkId, contactId: contact, leadId: entityId,
      textPreview: (text || "").slice(0,160),
      rawPreview: raw.toString("utf-8").slice(0, 300)
    });

    if (!res.writableEnded) res.status(200).json({ ok: true });
  } catch (e: any) {
    log.error("[GLOBAL v4] fatal", { err: e?.message || String(e) });
    if (!res.writableEnded) res.status(200).json({ ok: true });
  }
}
