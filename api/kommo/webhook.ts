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

function maskSecret(s: string | undefined) {
  if (!s) return "";
  const str = String(s);
  if (str.length <= 8) return "***";
  return `${str.slice(0, 2)}***${str.slice(-4)}`;
}

export const config = { runtime: "nodejs" };

export default async function handler(req: any, res: any) {
  const started = Date.now();
  try {
    const method = (req.method || "GET").toUpperCase();
    const urlPath: string = req.url || "";
    const ua = String(req.headers["user-agent"] || "");
    const ip =
      (req.headers["x-real-ip"] as string) ||
      (Array.isArray(req.headers["x-forwarded-for"])
        ? req.headers["x-forwarded-for"][0]
        : (req.headers["x-forwarded-for"] as string) || "");

    // Logs básicos (no PII sensible)
    console.log("📩 KOMMO WEBHOOK HIT", {
      method,
      urlPath,
      ua,
      ip,
      ct: req.headers["content-type"],
      cl: req.headers["content-length"],
    });

    if (method !== "GET" && method !== "POST") {
      console.warn("⚠️ Método no permitido:", method);
      return res.status(405).json({ error: "Method not allowed" });
    }

    // 1) Seguridad mínima (plan básico): secret por query o en el path
    //    Estilos soportados:
    //    - /api/kommo/webhook?secret=XXXX
    //    - /api/kommo/webhook/XXXX
    const pathSecret = (() => {
      const m = urlPath.match(/\/api\/kommo\/webhook\/([^/?#]+)/);
      return m?.[1] || "";
    })();
    const qsSecret = (req.query?.secret as string) || "";

    console.log("🔑 Secrets (masked)", {
      expected: maskSecret(WEBHOOK_SECRET),
      fromPath: maskSecret(pathSecret),
      fromQuery: maskSecret(qsSecret),
      usePathMatch: Boolean(pathSecret),
      useQueryMatch: Boolean(qsSecret),
    });

    if (WEBHOOK_SECRET && pathSecret !== WEBHOOK_SECRET && qsSecret !== WEBHOOK_SECRET) {
      console.warn("🚫 Secret inválido. Rechazando petición.");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 2) Normalización de payload
    const body: AnyDict = (req.body || {}) as AnyDict;

    // a) Formato simple (nuestro)
    let text = firstStr(body.text, req.query?.text);
    let leadId = firstNum(body.lead_id, req.query?.lead_id);

    // b) Formato "Chats Webhooks" de Kommo
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

    // c) Otros lugares típicos
    if (!text) {
      text = firstStr(
        body?.note?.text,
        body?.comment?.text,
        body?.last_message?.text
      );
    }

    // Loggear lo que detectamos (sin volarnos)
    console.log("🧩 Parsed payload snapshot", {
      hasBody: Object.keys(body).length > 0,
      query: req.query,
      derived: { text, leadId },
    });

    if (!text) {
      console.warn("❗ Missing text");
      return res.status(400).json({ error: "Missing text" });
    }
    if (!leadId) {
      console.warn("❗ Missing lead_id");
      return res.status(400).json({ error: "Missing lead_id" });
    }

    // 3) Llamar al Assistant con sesión por lead
    const result = await processWithAssistant({ text, leadId });

    // 4) Responder en Kommo con Nota
    if (result.text) {
      try {
        await postNoteToLead(leadId, result.text);
        console.log("📝 Nota creada en Kommo", { leadId, len: result.text.length });
      } catch (e) {
        console.error("💥 postNoteToLead error:", (e as any)?.response?.data || e);
      }
    }

    const duration = Date.now() - started;
    console.log("✅ Webhook OK", { leadId, thread_id: result.threadId, run_status: result.runStatus, ms: duration });

    return res.status(200).json({
      ok: true,
      leadId,
      text_in: text,
      text_out: result.text,
      thread_id: result.threadId,
      run_status: result.runStatus
    });
  } catch (err: any) {
    const duration = Date.now() - started;
    console.error("💥 kommo/webhook error:", err?.response?.data || err, { ms: duration });
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
