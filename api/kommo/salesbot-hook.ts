// pages/api/kommo/salesbot-hook.js
// Recibe widget_request del Salesbot, obtiene respuesta del Assistant
// y reanuda el Salesbot (continue o return_url).

import { continueSalesbot, continueViaReturnUrl, cleanSubdomain } from "../../../lib/kommo";
import { getAssistantReply } from "../../../lib/assistant";

export default async function handler(req, res) {
  try {
    // Ack inmediato para que Kommo no timeoutee
    res.status(200).json({ ok: true });

    const body = req.body || {};
    const account = body.account || {};
    const subdomain = cleanSubdomain(
      account.subdomain || process.env.KOMMO_SUBDOMAIN || ""
    );

    const botId = body.bot_id || body.bot?.id;
    const continueId = body.continue_id || body.bot?.continue_id;
    const returnUrl = body.return_url;

    // Datos enviados desde el bloque (script del widget)
    const data = body.data || {};
    const userMsg =
      data.message || data.message_text || body.message || body.message_text || "";

    // 1) Llama a tu servicio de Assistant (o usa fallback)
    const reply = await getAssistantReply(userMsg, {
      leadId: data.lead_id || body.lead_id,
      contactId: data.contact_id || body.contact_id,
      talkId: data.talk_id || body.talk_id,
    });

    // 2) Reanuda el Salesbot: preferimos Continue si hay token + ids
    let delivered = false;

    if (botId && continueId && process.env.KOMMO_ACCESS_TOKEN) {
      try {
        await continueSalesbot({
          subdomain,
          accessToken: process.env.KOMMO_ACCESS_TOKEN,
          botId,
          continueId,
          text: reply,
        });
        delivered = true;
      } catch (e) {
        console.error("[salesbot-hook] continue error:", e);
      }
    }

    // 3) Fallback a return_url (también oficial)
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
    // Ya enviamos 200 arriba; aquí sólo log
    console.error("[salesbot-hook] fatal:", err);
  }
}
