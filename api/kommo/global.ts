import type { VercelRequest, VercelResponse } from "@vercel/node";
import { mkLogger, genTraceId } from "../_lib/logger";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const traceId = (req.headers["x-trace-id"] as string) || genTraceId();
  const log = mkLogger(traceId);
  try {
    const ct = String(req.headers["content-type"] || "");
    const len = Number(req.headers["content-length"] || 0);
    log.info("[GLOBAL v4] meta", { ct, len });

    const raw = typeof req.body === "string" ? req.body : "";
    const keys = raw ? Array.from(new URLSearchParams(raw).keys()) : Object.keys(req.body || {});
    log.info("[GLOBAL v4] keys", keys);

    if (!res.writableEnded) return res.status(200).json({ ok: true });
  } catch (e: any) {
    log.error("[GLOBAL v4] fatal", { err: e?.message || String(e) });
    if (!res.writableEnded) return res.status(200).json({ ok: true });
  }
}
