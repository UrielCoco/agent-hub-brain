// agent-hub-brain/src/services/kommo.ts
import axios, { AxiosRequestConfig } from "axios";
import { KOMMO_BASE_URL, KOMMO_ACCESS_TOKEN } from "../config.js";

if (!KOMMO_BASE_URL) console.warn("⚠️ KOMMO_BASE_URL no está definido");
if (!KOMMO_ACCESS_TOKEN) console.warn("⚠️ KOMMO_ACCESS_TOKEN no está definido");

function authHeaders() {
  return { Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}` };
}

/**
 * Normaliza una URL para garantizar EXACTAMENTE un prefijo /api/v4.
 * Acepta que KOMMO_BASE_URL venga:
 *   - "https://sub.kommo.com"
 *   - "https://sub.kommo.com/"
 *   - "https://sub.kommo.com/api"
 *   - "https://sub.kommo.com/api/v4"
 * y asegura que el resultado final sea "https://sub.kommo.com/api/v4/<pathV4-sin-slash-inicial>"
 */
function apiV4Url(pathV4: string) {
  const base = (KOMMO_BASE_URL || "").replace(/\/+$/, ""); // sin trailing slash
  const cleanBase = base.replace(/\/api(?:\/v\d+)?$/i, ""); // le quita /api o /api/vX si viniera
  const cleanPath = pathV4.replace(/^\/+/, ""); // sin leading slash
  const finalUrl = `${cleanBase}/api/v4/${cleanPath}`;
  return finalUrl;
}

/**
 * Log de URL antes de disparar (para depurar 404 fácilmente)
 */
function logRequest(method: "GET" | "POST", url: string, extra?: any) {
  const info: any = { method, url };
  if (extra) info.extra = extra;
  console.log("🔗 KOMMO API", info);
}

/**
 * Crea una Nota "common" en el lead
 */
export async function postNoteToLead(leadId: number, text: string): Promise<void> {
  if (!leadId || !text) throw new Error("leadId/text required");
  const url = apiV4Url(`leads/${leadId}/notes`);
  const body = {
    note_type: "common",
    params: { text },
  };
  const cfg: AxiosRequestConfig = { headers: { ...authHeaders(), "Content-Type": "application/json" } };
  logRequest("POST", url, { bodyPreview: { note_type: "common", textLen: text.length } });
  await axios.post(url, body, cfg);
}

/**
 * Intenta obtener el último mensaje ENTRANTE del lead para usarlo como texto.
 * Probamos varias rutas porque difiere por cuenta/plan:
 *  1) /api/v4/chats/messages?filter[lead_id]={id}&order=desc&limit=1
 *  2) /api/v4/leads/{id}?with=last_message
 *  3) /api/v4/notes?filter[entity]=lead&filter[entity_id]={id}&order=desc&limit=1 (rescate)
 */
export async function getLatestMessageForLead(leadId: number): Promise<string | null> {
  if (!leadId) return null;

  // 1) chats/messages
  try {
    const url = apiV4Url("chats/messages");
    const params = { "filter[lead_id]": leadId, order: "desc", limit: 1 };
    logRequest("GET", url, { params });
    const { data } = await axios.get(url, { params, headers: authHeaders() });
    const items = data?._embedded?.messages || data?.messages || [];
    if (Array.isArray(items) && items.length > 0) {
      const msg = items[0];
      const t =
        msg?.text ??
        msg?.message?.text ??
        msg?.payload?.text ??
        null;
      if (t && String(t).trim()) return String(t).trim();
    }
  } catch (e: any) {
    console.warn("⚠️ chats/messages no disponible:", e?.response?.status, e?.response?.data || e?.message);
  }

  // 2) lead con last_message
  try {
    const url = apiV4Url(`leads/${leadId}`);
    const params = { with: "last_message" };
    logRequest("GET", url, { params });
    const { data } = await axios.get(url, { params, headers: authHeaders() });
    const t =
      data?.last_message?.text ??
      data?._embedded?.last_message?.text ??
      null;
    if (t && String(t).trim()) return String(t).trim();
  } catch (e: any) {
    console.warn("⚠️ lead.last_message no disponible:", e?.response?.status, e?.response?.data || e?.message);
  }

  // 3) última nota (como rescate; puede NO ser mensaje del cliente)
  try {
    const url = apiV4Url("notes");
    const params = {
      "filter[entity]": "lead",
      "filter[entity_id]": leadId,
      order: "desc",
      limit: 1,
    };
    logRequest("GET", url, { params });
    const { data } = await axios.get(url, { params, headers: authHeaders() });
    const items = data?._embedded?.notes || data?.notes || [];
    if (Array.isArray(items) && items.length > 0) {
      const n = items[0];
      const t =
        n?.params?.text ??
        n?.text ??
        null;
      if (t && String(t).trim()) return String(t).trim();
    }
  } catch (e: any) {
    console.warn("⚠️ notes (fallback) no disponible:", e?.response?.status, e?.response?.data || e?.message);
  }

  return null;
}
