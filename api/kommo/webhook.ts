// agent-hub-brain/api/kommo/webhook.ts
import { processWithAssistant } from "../../src/services/openai.js";
import { postNoteToLead } from "../../src/services/kommo.js";
import { WEBHOOK_SECRET } from "../../src/config.js";

type AnyDict = Record<string, any>;

function firstStr(...vals: any[]): string {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

function firstNum(...vals: any[]): number {
  for (const v of vals) {
    const n = Number(v);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 0;
}

export const config = { runtime: "nodejs" };

export default async function handler(req: any, res: any) {
  try {
    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // 1) Seguridad mínima (plan básico): secret por query o en el path
    //    Permite dos estilos:
    //    - /api/kommo/webhook?secret=XXXX
    //    - /api/kommo/webhook/XXXX
    const ua = String(req.headers["user-agent"] || "");
    if (!ua.toLowerCase().includes("amocrm-webhooks")) {
      // No es bala de plata, pero filtra bots accidentales
      // Si quieres quitar esto para pruebas locales, comenta la línea siguiente.
      // return res.status(403).json({ error: "Forbidden UA" });
    }

    const urlPath: string = req.url || ""; // e.g. "/api/kommo/webhook/SECRET?lead_id=1"
    const pathSecret = (() => {
      const m = urlPath.match(/\/api\/kommo\/webhook\/([^/?#]+)/);
      return m?.[1] || "";
    })();
    const qsSecret = (req.query?.secret as string) || "";
    if (WEBHOOK_SECRET && pathSecret !== WEBHOOK_SECRET && qsSecret !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 2) Normalización de payload
    const body: AnyDict = (req.body || {}) as AnyDict;

    // a) Formato simple (nuestro)
    let text = firstStr(body.text, req.query?.text);
    let leadId = firstNum(body.lead_id, req.query?.lead_id);

    // b) Formato "Chats Webhooks" de Kommo (según docs):
    //    Suele traer algo como:
    //    {
    //      "event": "...",
    //      "message": { "text": "...", "type": "...", ... },
    //      "conversation": { "id":..., "lead_id":..., ... },
    //      "contact": { "id":..., "name":... }, ...
    //    }
    if (!text) {
      text = firstStr(
        body?.message?.text,                 // texto del mensaje
        body?.message?.payload?.text,       // fallback común
        body?.data?.message?.text           // algunas variantes
      );
    }
    if (!leadId) {
      leadId = firstNum(
        body?.conversation?.lead_id,
        body?.lead?.id,
        body?.data?.lead_id
      );
    }

    // c) Otros lugares “típicos” en webhooks de Kommo
    if (!text) {
      text = firstStr(
        body?.note?.text,
        body?.comment?.text,
        body?.last_message?.text
      );
    }

    if (!text) return res.status(400).json({ error: "Missing text" });
    if (!leadId) return res.status(400).json({ error: "Missing lead_id" });

    // 3) Llamar al Assistant con sesión por lead
    const result = await processWithAssistant({ text, leadId });

    // 4) Responder en Kommo con Nota (y/o luego cambiamos a mensaje de salida del canal)
    if (result.text) {
      try {
        await postNoteToLead(leadId, result.text);
      } catch (e) {
        console.error("postNoteToLead error:", (e as any)?.response?.data || e);
      }
    }

    return res.status(200).json({
      ok: true,
      leadId,
      text_in: text,
      text_out: result.text,
      thread_id: result.threadId,
      run_status: result.runStatus
    });
  } catch (err: any) {
    console.error("kommo/webhook error:", err?.response?.data || err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}