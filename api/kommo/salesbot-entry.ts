import type { VercelRequest, VercelResponse } from "@vercel/node";
import { mkLogger, genTraceId } from "../_lib/logger";

/**
 * Este endpoint es llamado por el Salesbot (Código personalizado → widget_request).
 * - Si NO llegan bot_id/continue_id: devolvemos execute_handlers para que Kommo muestre la respuesta en el chat.
 * - Si SÍ llegan (modo Widget): intentamos continue (requiere token OAuth), y también devolvemos JSON.
 */

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

async function getAssistantReply(message: string, ctx: { leadId?: string; contactId?: string; traceId: string }) {
  // Llama a tu backend del assistant (proyecto coco-volare-ai-chat-main)
  const base = process.env.ASSISTANT_BASE_URL; // ej: https://coco-volare-ai-chat.vercel.app
  if (!base) return "¡Hola! ¿En qué puedo ayudarte hoy?";
  const url = `${base.replace(/\/+$/,"")}/api/reply`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      leadId: ctx.leadId,
      contactId: ctx.contactId,
      traceId: ctx.traceId,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  return (data?.reply || "¡Listo!").toString();
}

async function continueSalesbot(opts: {
  subdomain: string;
  botId: string;
  continueId: string;
  reply: string;
  traceId: string;
}) {
  const log = mkLogger(opts.traceId);
  const token = process.env.KOMMO_OAUTH_ACCESS_TOKEN; // Opcional (requerido sólo para "Widget")
  if (!token) {
    log.warn("continue:skip", { reason: "missing_token" });
    return false;
  }
  const url = `https://${opts.subdomain}.kommo.com/api/v4/salesbot/${opts.botId}/continue/${opts.continueId}`;
  log.info("continueSalesbot → POST", { url, textPreview: opts.reply.slice(0, 160) });
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      data: { status: "success" },
      execute_handlers: [
        { handler: "show", params: { type: "text", value: opts.reply.slice(0, 800) } },
      ],
    }),
  });
  const preview = await r.text();
  log.info("continueSalesbot ← resp", { status: r.status, len: preview.length, preview: preview.slice(0, 160) });
  return r.ok;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const traceId = (req.headers["x-trace-id"] as string) || genTraceId();
  const log = mkLogger(traceId);

  try {
    const ct = String(req.headers["content-type"] || "");
    const body: any =
      ct.includes("application/json")
        ? req.body
        : ct.includes("application/x-www-form-urlencoded")
        ? Object.fromEntries(new URLSearchParams(String(req.body || "")).entries())
        : req.body || {};

    const { account = {}, data = {}, bot_id, continue_id, return_url } = body || {};

    log.info("entry:received", {
      path: req.url,
      method: req.method,
      ct,
      keys: Object.keys(body || {}),
    });

    // Detectar si por error llegó Global
    if (typeof body["message[add][0][text]"] !== "undefined") {
      log.warn("entry:got_global_payload", {
        hint:
          "Este endpoint es SOLO para widget_request/Widget del Salesbot. Deja el Webhook Global en /api/kommo/global",
      });
      if (!res.writableEnded) return res.status(200).json({ data: { status: "skip" } });
      return;
    }

    const userMsg =
      data?.message ??
      data?.message_text ??
      body?.message ??
      body?.message_text ??
      "";
    const subdomain = (account?.subdomain || process.env.KOMMO_SUBDOMAIN || "").replace(/^https?:\/\/|\.amocrm\.com|\.kommo\.com/gi, "");
    const leadId = data?.lead_id || body?.lead_id;
    const contactId = data?.contact_id || body?.contact_id;

    log.info("entry:userMsg", { preview: String(userMsg || "").slice(0, 160) });
    log.debug?.("entry:context", { subdomain, bot_id, continue_id, hasReturnUrl: !!return_url });

    // 1) Obtener respuesta del assistant
    const reply = await getAssistantReply(String(userMsg || ""), { leadId, contactId, traceId });
    log.info("assistant:reply", { preview: reply.slice(0, 160) });

    // 2) Si NO llegaron IDs => estamos en widget_request: responder execute_handlers (Kommo lo muestra en el chat).
    if (!bot_id || !continue_id) {
      const payload = {
        data: { status: "success" },
        execute_handlers: [{ handler: "show", params: { type: "text", value: reply.slice(0, 800) } }],
      };
      if (!res.writableEnded) return res.status(200).json(payload);
      return;
    }

    // 3) Si SÍ llegaron IDs => intentar continue (modo Widget + OAuth)
    const ok = await continueSalesbot({
      subdomain,
      botId: String(bot_id),
      continueId: String(continue_id),
      reply,
      traceId,
    });

    // 4) Fallback: notificar return_url si vino
    if (!ok && return_url) {
      log.info("return_url → POST", { returnUrl: return_url });
      try {
        const r = await fetch(return_url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: { status: "success", reply } }),
        });
        const t = await r.text();
        log.info("return_url ← resp", { status: r.status, len: t.length, preview: t.slice(0, 160) });
      } catch (e: any) {
        log.error("return_url:error", { err: String(e) });
      }
    }

    if (!res.writableEnded) return res.status(200).json({ status: "success", reply, traceId });
  } catch (err: any) {
    mkLogger(traceId).error("entry:fatal", { err: err?.message || String(err) });
    if (!res.writableEnded) return res.status(500).json({ status: "error", traceId });
  }
}
