// api/kommo/salesbot-hook.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { mkLogger, genTraceId } from "../_lib/logger";
import { continueSalesbot, continueViaReturnUrl, cleanSubdomain, addLeadNote } from "../_lib/kommo";
import { getAssistantReply } from "../_lib/assistant";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const traceId = (req.headers["x-trace-id"] as string) || genTraceId();
  const log = mkLogger(traceId);

  try {
    // 1) Acknowledge de volada para que Kommo no corte
    if (!res.writableEnded) res.status(200).json({ ok: true });

    const ct = String(req.headers["content-type"] || "");
    const body: any = req.body || {};
    log.info("hook:received", { ct, keys: Object.keys(body || {}).slice(0,20) });

    // 2) Extract básicos del widget_request
    const subdomain = cleanSubdomain(body?.account?.subdomain || process.env.KOMMO_SUBDOMAIN || "");
    const botId      = body?.bot_id || body?.bot?.id;
    const continueId = body?.continue_id || body?.bot?.continue_id;
    const returnUrl  = body?.return_url;

    const data   = body?.data || {};
    const userMsg = data?.message || data?.message_text || body?.message || body?.message_text || "";

    log.debug("hook:context", { subdomain, botId, continueId, hasReturnUrl: !!returnUrl });
    log.info("hook:userMsg", { preview: String(userMsg).slice(0,160) });

    // 3) Llamada al Assistant (tu otro proyecto)
    log.info("assistant:call →", { base: process.env.ASSISTANT_BASE_URL ? "external" : "embedded" });
    const reply = await getAssistantReply(String(userMsg || ""), {
      leadId: data?.lead_id || body?.lead_id,
      contactId: data?.contact_id || body?.contact_id,
      talkId: data?.talk_id || body?.talk_id,
      traceId,
    });
    log.info("assistant:reply ←", { preview: String(reply).slice(0,160) });

    // (Opcional) Nota en lead
    const leadId = Number(data?.lead_id || body?.lead_id || 0);
    if (leadId) {
      try {
        await addLeadNote(leadId, `🤖 Assistant: ${reply}`, traceId);
        log.debug("lead:note:ok", { leadId });
      } catch (e: any) {
        log.warn("lead:note:fail", { err: e?.message || String(e) });
      }
    }

    // 4) Reanudar el Salesbot
    let delivered = false;
    if (botId && continueId && process.env.KOMMO_ACCESS_TOKEN) {
      try {
        await continueSalesbot({
          subdomain, accessToken: process.env.KOMMO_ACCESS_TOKEN!,
          botId: String(botId), continueId: String(continueId),
          text: reply, extraData: {}, traceId
        });
        delivered = true;
      } catch (e: any) {
        log.error("continue:error", { err: e?.message || String(e) });
      }
    } else {
      log.warn("continue:skip", { reason: "missing botId/continueId/token" });
    }

    // 5) Fallback con return_url
    if (!delivered && returnUrl) {
      try {
        await continueViaReturnUrl(returnUrl, { status: "success", reply }, traceId);
        delivered = true;
      } catch (e: any) {
        log.error("return_url:error", { err: e?.message || String(e) });
      }
    }

    if (!delivered) {
      log.error("deliver:failed", { hint: "Faltan botId/continueId/return_url o token inválido" });
    } else {
      log.info("deliver:ok");
    }
  } catch (err: any) {
    const log2 = mkLogger(traceId);
    log2.error("hook:fatal", { err: err?.message || String(err) });
    if (!res.writableEnded) res.status(200).json({ ok: true });
  }
}
