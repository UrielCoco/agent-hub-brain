import type { VercelRequest, VercelResponse } from "@vercel/node";
import { mkLogger, genTraceId } from "../_lib/logger";
import { continueSalesbot, continueViaReturnUrl, cleanSubdomain, addLeadNote } from "../_lib/kommo";
import { getAssistantReply } from "../_lib/assistant";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const traceId = (req.headers["x-trace-id"] as string) || genTraceId();
  const log = mkLogger(traceId);

  try {
    if (!res.writableEnded) res.status(200).json({ ok: true });

    const ct = String(req.headers["content-type"] || "");
    const body: any = req.body || {};

    const keys = Object.keys(body || {});
    log.info("hook:received", { ct, keys });

    // ¿Parece payload del webhook global?
    const looksGlobal = typeof body["message[add][0][text]"] !== "undefined";
    if (looksGlobal) {
      const txt = body["message[add][0][text]"] || "";
      log.warn("hook:payload_looks_like_global", {
        hint: "Este endpoint es para widget_request del Salesbot (o tu Widget). Deja el Webhook Global en /api/kommo/global y usa widget_request hacia /api/kommo/salesbot-hook.",
        textPreview: String(txt).slice(0,160)
      });
      return; // No podemos continuar el bot sin continue_id/return_url
    }

    // Extraemos lo que sí trae el widget_request
    const subdomain = cleanSubdomain(body?.account?.subdomain || process.env.KOMMO_SUBDOMAIN || "");
    const botId      = body?.bot_id || body?.bot?.id;
    const continueId = body?.continue_id || body?.bot?.continue_id;
    const returnUrl  = body?.return_url;

    const data   = body?.data || {};
    const userMsg = data?.message || data?.message_text || body?.message || body?.message_text || "";

    log.info("hook:userMsg", { preview: String(userMsg).slice(0,160) });
    log.debug("hook:context", { subdomain, botId, continueId, hasReturnUrl: !!returnUrl });

    // Llamada a tu backend del assistant
    const reply = await getAssistantReply(String(userMsg || ""), {
      leadId: data?.lead_id || body?.lead_id,
      contactId: data?.contact_id || body?.contact_id,
      talkId: data?.talk_id || body?.talk_id,
      traceId,
    });
    log.info("assistant:reply ←", { preview: String(reply).slice(0,160) });

    // Nota en lead (opcional)
    const leadId = Number(data?.lead_id || body?.lead_id || 0);
    if (leadId) {
      try { await addLeadNote(leadId, `🤖 Assistant: ${reply}`, traceId); }
      catch (e: any) { log.warn("lead:note:fail", { err: e?.message || String(e) }); }
    }

    // Intento 1: continue con token
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

    // Intento 2: return_url
    if (!delivered && returnUrl) {
      try {
        await continueViaReturnUrl(returnUrl, reply, {}, traceId);
        delivered = true;
      } catch (e: any) {
        log.error("return_url:error", { err: e?.message || String(e) });
      }
    }

    if (!delivered) {
      log.error("deliver:failed", {
        hint: "Asegúrate de llamar este endpoint desde widget_request o tu widget (no desde Webhook Global)."
      });
    } else {
      log.info("deliver:ok");
    }
  } catch (err: any) {
    const log2 = mkLogger(traceId);
    log2.error("hook:fatal", { err: err?.message || String(err) });
    if (!res.writableEnded) res.status(200).json({ ok: true });
  }
}
