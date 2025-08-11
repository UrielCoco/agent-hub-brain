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
// parsea application/x-www-form-urlencoded si llega como string
function parseFormUrlencoded(s: string): AnyDict {
  const out: AnyDict = {};
  const usp = new URLSearchParams(s);
  for (const [k, v] of usp.entries()) out[k] = v;
  return out;
}
// busca posibles llaves de texto en payloads raros
function findTextLoose(obj: AnyDict): string {
  const candidates: string[] = [];
  const push = (v: any) => { if (v) candidates.push(String(v)); };
  try {
    push(obj?.message?.text);
    push(obj?.message?.payload?.text);
    push(obj?.data?.message?.text);
    push(obj?.note?.text);
    push(obj?.comment?.text);
    push(obj?.last_message?.text);
    // si viene flat del form-urlencoded:
    for (const k of Object.keys(obj)) {
      const lk = k.toLowerCase();
      if (lk.includes("text") || lk.includes("message")) push(obj[k]);
      if (lk.endsWith("[text]")) push(obj[k]);
    }
  } catch {}
  return firstStr(...candidates);
}
function findLeadIdLoose(obj: AnyDict): number {
  const cands: any[] = [];
  try {
    cands.push(obj?.conversation?.lead_id);
    cands.push(obj?.lead?.id);
    cands.push(obj?.data?.lead_id);
    // si viene flat del form-urlencoded:
    for (const k of Object.keys(obj)) {
      const lk = k.toLowerCase();
      if (lk.endsWith("lead_id") || lk.endsWith("[lead_id]") || lk.endsWith("[id]")) {
        cands.push(obj[k]);
      }
      if (lk.includes("lead") && (lk.includes("id") || lk.endsWith("_id"))) {
        cands.push(obj[k]);
      }
    }
  } catch {}
  return firstNum(...cands);
}

export const config = { runtime: "nodejs" };

export default async function handler(req: any, res: any) {
  const started = Date.now();
  try {
    const method = (req.method || "GET").toUpperCase();
    const urlPath: string = req.url || "";
    const ua = String(req.headers["user-agent"] || "");
    console.log("📩 KOMMO WEBHOOK HIT", {
      method, urlPath, ua,
      ct: req.headers["content-type"], cl: req.headers["content-length"]
    });

    if (method !== "GET" && method !== "POST") {
      console.warn("⚠️ Método no permitido:", method);
      return res.status(405).json({ error: "Method not allowed" });
    }

    // secret por path o query (plan básico)
    const pathSecret = (() => {
      const m = urlPath.match(/\/api\/kommo\/webhook\/([^/?#]+)/);
      return m?.[1] || "";
    })();
    const qsSecret = (req.query?.secret as string) || "";
    console.log("🔑 Secrets (masked)", {
      expected: maskSecret(WEBHOOK_SECRET),
      fromPath: maskSecret(pathSecret),
      fromQuery: maskSecret(qsSecret)
    });
    if (WEBHOOK_SECRET && pathSecret !== WEBHOOK_SECRET && qsSecret !== WEBHOOK_SECRET) {
      console.warn("🚫 Secret inválido. Rechazando petición.");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // payload: soporta JSON, form-urlencoded, query
    let body: AnyDict = (req.body ?? {}) as AnyDict;
    if (typeof body === "string") {
      // Vercel a veces entrega el form body como string
      body = parseFormUrlencoded(body);
    } else if (
      (!body || Object.keys(body).length === 0) &&
      typeof req.rawBody === "string"
    ) {
      // si existiera rawBody
      body = parseFormUrlencoded(req.rawBody);
    }

    // a) nuestro simple
    let text = firstStr(body?.text, req.query?.text);
    let leadId = firstNum(body?.lead_id, req.query?.lead_id);

    // b) formatos Kommo varios (Chats / embudo)
    if (!text) text = findTextLoose(body);
    if (!leadId) leadId = findLeadIdLoose(body);

    console.log("🧩 Parsed payload", {
      bodyKeys: Object.keys(body || {}),
      sample: Object.fromEntries(Object.entries(body || {}).slice(0, 10)),
      derived: { text, leadId }
    });

    if (!text) {
      console.warn("❗ Missing text");
      return res.status(400).json({ error: "Missing text" });
    }
    if (!leadId) {
      console.warn("❗ Missing lead_id");
      return res.status(400).json({ error: "Missing lead_id" });
    }

    // 3) Assistant (sesión por lead)
    const result = await processWithAssistant({ text, leadId });

    // 4) Nota en Kommo
    if (result.text) {
      try {
        await postNoteToLead(leadId, result.text);
        console.log("📝 Nota creada", { leadId, len: result.text.length });
      } catch (e) {
        console.error("💥 postNoteToLead error:", (e as any)?.response?.data || e);
      }
    }

    console.log("✅ OK", {
      leadId, thread_id: result.threadId, run_status: result.runStatus,
      ms: Date.now() - started
    });

    return res.status(200).json({
      ok: true,
      leadId,
      text_in: text,
      text_out: result.text,
      thread_id: result.threadId,
      run_status: result.runStatus
    });
  } catch (err: any) {
    console.error("💥 kommo/webhook error:", err?.response?.data || err, { ms: Date.now() - started });
    return res.status(500).json({ error: err?.message || "Server error" });
  }
}
