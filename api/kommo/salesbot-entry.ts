import type { VercelRequest, VercelResponse } from "@vercel/node";
import { mkLogger, genTraceId } from "../_lib/logger";
import { continueSalesbot, continueViaReturnUrl, cleanSubdomain, addLeadNote } from "../_lib/kommo";
import { getAssistantReply } from "../_lib/assistant";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const traceId = (req.headers["x-trace-id"] as string) || genTraceId();
  const log = mkLogger(traceId);

  try {
    const ct = String(req.headers["content-type"] || "");
    const body: any = req.body || {};
    const keys = Object.keys(body || {});
    log.info("entry:received", { path: req.url, method: req.method, ct, keys });

    // Si por error llega payload del Webhook Global, ignóralo
    const looksGlobal = typeof body["message[add][0][text]"] !== "undefined";
    if (looksGlobal) {
      log.warn("entry:got_global_payload", { hint: "Este endpoint es SOLO para widget_request/Widget." });
      return res.status(200).json({ status: "fail", reply: "" });
    }

    const subdomain = cleanSubdomain(body?.account?.subdomain || process.env.KOMMO_SUBDOMAIN || "");
    const botId      = body?.bot_id || body?.bot?.id;
    const continueId = body?.continue_id || body?.bot?.continue_id;
    const returnUrl  = body?.return_url;

    const data    = body?.data || {};
    const userMsg = data?.message || data?.message_text || body?.message || body?.message_text || "";
    log.info("entry:userMsg", { preview: String(userMsg).slice(0,160) });
    log.debug("entry:context", { subdomain, botId, continueId, hasReturnUrl: !!returnUrl });

    const reply = "ENTRY▶ " + (await getAssistantReply(String(userMsg || ""), {
      leadId: data?.lead_id || body?.lead_id,
      contactId: data?.contact_id || body?.contact_id,
      talkId: data?.talk_id || body?.talk_id,
      traceId,
    }));
    log.info("assistant:reply", { preview: String(reply).slice(0,160) });

    const leadId = Number(data?.lead_id || body?.lead_id || 0);
    if (leadId) {
      try { await addLeadNote(leadId, `🤖 Assistant: ${reply}`, traceId); }
      catch (e: any) { log.warn("lead:note:fail", { err: e?.message || String(e) }); }
    }

    let delivered = false;
    if (botId && continueId && process.env.KOMMO_ACCESS_TOKEN) {
      try {
        await continueSalesbot({
          subdomain,
          accessToken: process.env.KOMMO_ACCESS_TOKEN!,
          botId: String(botId),
          continueId: String(continueId),
          text: reply,
          traceId
        });
        delivered = true;
      } catch (e: any) {
        log.error("continue:error", { err: e?.message || String(e) });
      }
    } else {
      log.warn("continue:skip", { reason: "missing botId/continueId/token" });
    }

    if (!delivered && returnUrl) {
      try {
        await continueViaReturnUrl(returnUrl, { status: "success", reply }, traceId);
        delivered = true;
      } catch (e: any) {
        log.error("return_url:error", { err: e?.message || String(e) });
      }
    }

    if (!delivered) log.error("deliver:failed");
    else log.info("deliver:ok");

    // También devolvemos JSON por si usas {{json.reply}}
    return res.status(200).json({ status: "success", reply, traceId });
  } catch (err: any) {
    mkLogger(traceId).error("entry:fatal", { err: err?.message || String(err) });
    return res.status(200).json({ status: "fail", reply: "" });
  }
}
