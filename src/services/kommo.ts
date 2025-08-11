// agent-hub-brain/src/services/kommo.ts
import axios from "axios";
import { KOMMO_BASE_URL, KOMMO_ACCESS_TOKEN } from "../config.js";

if (!KOMMO_BASE_URL) console.warn("⚠️ KOMMO_BASE_URL no está definido");
if (!KOMMO_ACCESS_TOKEN) console.warn("⚠️ KOMMO_ACCESS_TOKEN no está definido");

function authHeaders() {
  return { Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}` };
}

/** Normaliza el base y asegura /api/v4 */
function apiV4Url(pathV4: string) {
  const base = (KOMMO_BASE_URL || "").replace(/\/+$/, "");
  const cleanBase = base.replace(/\/api(?:\/v\d+)?$/i, "");
  const cleanPath = pathV4.replace(/^\/+/, "");
  return `${cleanBase}/api/v4/${cleanPath}`;
}

/** Log de URLs para depurar */
function logRequest(method: "GET" | "POST", url: string, extra?: any) {
  const info: any = { method, url };
  if (extra) info.extra = extra;
  console.log("🔗 KOMMO API", info);
}

/** Publica una nota en un LEAD (formato correcto: array) */
export async function postNoteToLead(leadId: number, text: string) {
  const url = apiV4Url(`leads/${leadId}/notes`);
  const body = [
    { note_type: "common", params: { text } }
  ];
  const cfg = { headers: { ...authHeaders(), "Content-Type": "application/json" } };
  logRequest("POST", url, { bodyPreview: { note_type: "common", textLen: text.length } });
  await axios.post(url, body, cfg);
}

/** (Opcional) Publica una nota en un CONTACTO principal */
export async function postNoteToContact(contactId: number, text: string) {
  const url = apiV4Url(`contacts/${contactId}/notes`);
  const body = [
    { note_type: "common", params: { text } }
  ];
  const cfg = { headers: { ...authHeaders(), "Content-Type": "application/json" } };
  logRequest("POST", url, { bodyPreview: { note_type: "common", textLen: text.length } });
  await axios.post(url, body, cfg);
}

/** Obtiene el contacto principal del lead */
async function getMainContactIdForLead(leadId: number): Promise<number | null> {
  const url = apiV4Url(`leads/${leadId}`);
  const params = { with: "contacts" };
  logRequest("GET", url, { params });
  const { data } = await axios.get(url, { params, headers: authHeaders() });
  const contacts = data?._embedded?.contacts || [];
  const main = contacts.find((c: any) => c?.is_main) || contacts[0];
  return main?.id ? Number(main.id) : null;
}

/** Lee el último mensaje del lead; si no, cae al contacto principal */
export async function getLatestMessageForLead(leadId: number): Promise<string | null> {
  if (!leadId) return null;

  const pickText = (n: any) =>
    n?.params?.text ?? n?.text ?? n?.value ?? n?.message?.text ?? null;

  // 1) last_message directo en el lead
  try {
    const url = apiV4Url(`leads/${leadId}`);
    const params = { with: "last_message" };
    logRequest("GET", url, { params });
    const { data } = await axios.get(url, { params, headers: authHeaders() });
    const t = data?.last_message?.text ?? data?._embedded?.last_message?.text ?? null;
    if (t && String(t).trim()) return String(t).trim();
  } catch (e: any) {
    console.warn("⚠️ lead.last_message no disponible:", e?.response?.status, e?.response?.data || e?.message);
  }

  // 2) Notas del LEAD (endpoint anidado)
  try {
    const url = apiV4Url(`leads/${leadId}/notes`);
    const params = { order: "desc", limit: 10 };
    logRequest("GET", url, { params });
    const { data } = await axios.get(url, { params, headers: authHeaders() });
    const notes = data?._embedded?.notes || [];
    console.log("🧾 lead/{id}/notes sample:", notes.slice(0, 2).map((n: any) => ({
      id: n?.id, type: n?.note_type || n?.type, keys: Object.keys(n || {})
    })));
    const mark = notes.find((n: any) => (pickText(n) || "").startsWith("[BOT-MARK]"));
    if (mark) {
      const t = String(pickText(mark)).replace(/^\[BOT-MARK\]\s*/, "").trim();
      if (t) return t;
    }
    for (const n of notes) {
      const t = pickText(n);
      if (t && String(t).trim()) return String(t).trim();
    }
  } catch (e: any) {
    console.warn("⚠️ leads/{id}/notes no disponible:", e?.response?.status, e?.response?.data || e?.message);
  }

  // 3) Fallback: Notas del CONTACTO PRINCIPAL
  try {
    const contactId = await getMainContactIdForLead(leadId);
    if (contactId) {
      const url = apiV4Url(`contacts/${contactId}/notes`);
      const params = { order: "desc", limit: 10 };
      logRequest("GET", url, { params });
      const { data } = await axios.get(url, { params, headers: authHeaders() });
      const notes = data?._embedded?.notes || [];
      console.log("🧾 contact/{id}/notes sample:", notes.slice(0, 2).map((n: any) => ({
        id: n?.id, type: n?.note_type || n?.type, keys: Object.keys(n || {})
      })));
      const mark = notes.find((n: any) => (pickText(n) || "").startsWith("[BOT-MARK]"));
      if (mark) {
        const t = String(pickText(mark)).replace(/^\[BOT-MARK\]\s*/, "").trim();
        if (t) return t;
      }
      for (const n of notes) {
        const t = pickText(n);
        if (t && String(t).trim()) return String(t).trim();
      }
    }
  } catch (e: any) {
    console.warn("⚠️ contacts/{id}/notes no disponible:", e?.response?.status, e?.response?.data || e?.message);
  }

  // 4) (Opcional) chats/* si tu cuenta lo expone
  try {
    const cu = apiV4Url("chats/conversations");
    const cparams = { "filter[lead_id]": leadId, order: "desc", limit: 1 };
    logRequest("GET", cu, { params: cparams });
    const { data: cd } = await axios.get(cu, { params: cparams, headers: authHeaders() });
    const convs = cd?._embedded?.conversations || cd?.conversations || [];
    if (Array.isArray(convs) && convs.length > 0) {
      const convId = convs[0]?.id ?? convs[0]?.conversation_id ?? convs[0]?.uuid ?? null;
      if (convId) {
        const mu = apiV4Url("chats/messages");
        const mparams = { "filter[conversation_id]": convId, order: "desc", limit: 1 };
        logRequest("GET", mu, { params: mparams });
        const { data: md } = await axios.get(mu, { params: mparams, headers: authHeaders() });
        const items = md?._embedded?.messages || md?.messages || [];
        console.log("💬 messages sample:", items.slice(0, 2).map((m: any) => ({
          keys: Object.keys(m || {}), hasText: !!(m?.text || m?.message?.text || m?.payload?.text)
        })));
        if (Array.isArray(items) && items.length > 0) {
          const msg = items[0];
          const t = msg?.text ?? msg?.message?.text ?? msg?.payload?.text ?? null;
          if (t && String(t).trim()) return String(t).trim();
        }
      }
    }
  } catch (e: any) {
    console.warn("⚠️ chats/* no disponible:", e?.response?.status, e?.response?.data || e?.message);
  }

  return null;
}

export { apiV4Url, authHeaders, logRequest }; // por si los usas en otros lugares