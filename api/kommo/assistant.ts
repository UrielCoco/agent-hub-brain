// /Users/uriel/Projects/agent-hub-brain/api/kommo/assistant.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAssistantReply } from "../_lib/assistant";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

function tid() { return "assistant_" + Math.random().toString(36).slice(2); }
function log(level: "info" | "warn" | "error", msg: string, meta?: any, traceId?: string) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, traceId, msg, meta }));
}

function normalizeBody(req: VercelRequest) {
  const ct = String(req.headers["content-type"] || "");
  const raw = typeof req.body === "string" ? req.body : "";

  if (ct.includes("application/json")) {
    if (typeof req.body === "string") {
      try { return JSON.parse(req.body); } catch { return { raw: req.body }; }
    }
    return req.body || {};
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    try {
      const params = new URLSearchParams(raw);
      const obj: any = {};
      params.forEach((v, k) => (obj[k] = v));
      return obj;
    } catch { return req.body || {}; }
  }
  return req.body || {};
}

function pickMessage(body: any): string {
  return (
    body?.message?.text ??
    body?.message ??
    body?.data?.message ??
    body?.message_text ??
    ""
  ).toString().trim();
}
function pickReturnUrl(body: any): string | undefined {
  return body?.return_url || body?.data?.return_url || body?.callback_url;
}

async function postReturn(returnUrl: string, payload: { data?: any; execute_handlers?: any[] }, traceId: string) {
  const r = await fetch(returnUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      data: payload.data ?? {},
      execute_handlers: payload.execute_handlers ?? [],
    }),
  });
  const txt = await r.text().catch(() => "");
  log("info", "return_url ← resp", { status: r.status, len: txt.length, preview: txt.slice(0, 200) }, traceId);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const traceId = tid();
  try {
    const ct = String(req.headers["content-type"] || "");
    const body = normalizeBody(req);
    const keys = Object.keys(body || {});
    log("info", "ASSISTANT:received", { method: req.method, url: req.url, ct, keys }, traceId);

    const returnUrl = pickReturnUrl(body);
    if (!returnUrl) {
      log("warn", "ASSISTANT:return_url_missing", {}, traceId);
      return res.status(400).json({ error: "return_url requerido" });
    }

    const message = pickMessage(body);
    const ctx = {
      subdomain: body?.account?.subdomain || body?.subdomain,
      leadId: body?.lead_id || body?.leadId || body?.data?.lead_id,
      contactId: body?.contact_id || body?.contactId || body?.data?.contact_id,
      talkId: body?.talk_id || body?.talkId || body?.data?.talk_id,
      traceId,
    };

    // 1) ACK inmediato (< 2s) como pide la doc
    res.status(200).json({ status: "ok", traceId });

    // 2) Ya fuera del request, obtener respuesta del assistant y continuar el bot
    (async () => {
      try {
        const reply = await getAssistantReply(message, ctx);

        const payload = {
          data: { status: "success" },
          execute_handlers: [
            { handler: "show", params: { type: "text", value: reply } },
            // Si quieres forzar salto de paso: { handler: "goto", params: { type: "question", step: 1 } }
          ],
        };

        await postReturn(returnUrl, payload, traceId);
      } catch (e: any) {
        log("error", "ASSISTANT:background_error", { err: e?.message || String(e) }, traceId);
        const payload = {
          data: { status: "error" },
          execute_handlers: [
            { handler: "show", params: { type: "text", value: "Tuve un detalle técnico. ¿Puedes repetirlo?" } }
          ]
        };
        try { await postReturn(returnUrl, payload, traceId); } catch {}
      }
    })();

  } catch (e: any) {
    log("error", "ASSISTANT:fatal", { err: e?.message || String(e) }, traceId);
    // Nota: si llegamos aquí, preferimos 200 con error para no romper el bloque
    res.status(200).json({ data: { status: "error" }, traceId });
  }
}
