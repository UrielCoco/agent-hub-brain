// agent-hub-brain-main/api/kommo/salesbot-hook.ts
// Recibe widget_request del Salesbot → llama al Assistant → reanuda el bot (continue o return_url).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { continueSalesbot, continueViaReturnUrl, cleanSubdomain } from "../_lib/kommo";
import { getAssistantReply } from "../_lib/assistant";

// (opcional) limita tamaño del body
export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // 1) Ack inmediato para que Kommo no corte la llamada
    if (!res.writableEnded) res.status(200).json({ ok: true });

    // 2) Desempaqueta payload del widget_request
    const body: any = req.body || {};
    const subdomain = cleanSubdomain(
      body?.account?.subdomain || process.env.KOMMO_SUBDOMAIN || ""
    );
    const botId = body?.bot_id || body?.bot?.id;
    const continueId = body?.continue_id || body?.bot?.continue_id;
    const returnUrl = body?.return_url;

    const data = body?.data || {};
    const userMsg =
      data?.message ||
      data?.message_text ||
      body?.message ||
      body?.message_text ||
      "";

    // 3) Llama a tu Assistant
    const reply = await getAssistantReply(userMsg, {
      leadId: data?.lead_id || body?.lead_id,
      contactId: data?.contact_id || body?.contact_id,
      talkId: data?.talk_id || body?.talk_id,
    });

    // 4) Reanuda el Salesbot (preferimos continue con token)
    let delivered = false;

    if (botId && continueId && process.env.KOMMO_ACCESS_TOKEN) {
      try {
        await continueSalesbot({
          subdomain,
          accessToken: process.env.KOMMO_ACCESS_TOKEN!,
          botId: String(botId),
          continueId: String(continueId),
          text: reply,
        });
        delivered = true;
      } catch (e) {
        console.error("[salesbot-hook] continue error:", e);
      }
    }

    // 5) Fallback: return_url
    if (!delivered && returnUrl) {
      try {
        await continueViaReturnUrl(returnUrl, { status: "success", reply });
        delivered = true;
      } catch (e) {
        console.error("[salesbot-hook] return_url error:", e);
      }
    }

    if (!delivered) {
      console.warn(
        "[salesbot-hook] No pude reanudar el bot (faltan bot_id/continue_id/return_url o token)."
      );
    }
  } catch (err) {
    console.error("[salesbot-hook] fatal:", err);
    if (!res.writableEnded) res.status(200).json({ ok: true });
  }
}
