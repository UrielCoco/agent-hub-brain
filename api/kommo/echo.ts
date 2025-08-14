import type { VercelRequest, VercelResponse } from "@vercel/node";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

function log(level: "info" | "warn" | "error", msg: string, meta?: any, traceId?: string) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, traceId, msg, meta }));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const traceId = "echo_" + Math.random().toString(36).slice(2);
  try {
    const ct = String(req.headers["content-type"] || "");
    const raw = typeof req.body === "string" ? req.body : "";
    const keys = raw ? Array.from(new URLSearchParams(raw).keys()) : Object.keys(req.body || {});
    log("info", "ECHO:received", { method: req.method, url: req.url, ct, keys }, traceId);

    // Intenta parsear body de varias formas:
    let data: any = {};
    try {
      if (ct.includes("application/json") && typeof req.body !== "string") data = req.body || {};
      else if (ct.includes("application/x-www-form-urlencoded")) {
        data = Object.fromEntries(new URLSearchParams(raw).entries());
      }
    } catch {}

    log("info", "ECHO:body", { preview: JSON.stringify(data).slice(0, 300) }, traceId);

    // Responder algo que Kommo pueda mostrar en el chat
    const value = data?.message || data?.message_text || "👋 ECHO: sin 'message'";
    const payload = {
      data: { status: "success" },
      execute_handlers: [
        { handler: "show", params: { type: "text", value: `ECHO ▶ ${String(value).slice(0, 120)}` } }
      ]
    };
    return res.status(200).json(payload);
  } catch (e: any) {
    log("error", "ECHO:error", { err: e?.message || String(e) }, traceId);
    return res.status(200).json({ data: { status: "error" } });
  }
}
