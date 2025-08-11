// agent-hub-brain/src/services/kommo.ts
import axios, { AxiosRequestConfig } from "axios";
import { KOMMO_BASE_URL, KOMMO_ACCESS_TOKEN } from "../config.js";

if (!KOMMO_BASE_URL) console.warn("⚠️ KOMMO_BASE_URL no está definido");
if (!KOMMO_ACCESS_TOKEN) console.warn("⚠️ KOMMO_ACCESS_TOKEN no está definido");

function authHeaders() {
  return { Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}` };
}

function baseUrl(path: string) {
  const root = KOMMO_BASE_URL?.replace(/\/+$/, "") || "";
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${root}${p}`;
}

/**
 * Crea una Nota "common" en el lead
 */
export async function postNoteToLead(leadId: number, text: string): Promise<void> {
  if (!leadId || !text) throw new Error("leadId/text required");
  const url = baseUrl(`/api/v4/leads/${leadId}/notes`);
  const body = {
    note_type: "common",
    params: { text },
  };
  const cfg: AxiosRequestConfig = { headers: { ...authHeaders(), "Content-Type": "application/json" } };
  const { data } = await axios.post(url, body, cfg);
  return data;
}

/**
 * Intenta obtener el último mensaje entrante del lead para usarlo como texto
 * Probamos varias rutas porque difiere por cuenta/plan:
 *  1) /api/v4/chats/messages?filter[lead_id]={id}&order=desc&limit=1
 *  2) /api/v4/leads/{id}?with=last_message  (si la cuenta expone last_message)
 *  3) /api/v4/notes?filter[entity]=lead&filter[entity_id]={id}&order=desc&limit=1 (como rescate)
 */
export async function getLatestMessageForLead(leadId: number): Promise<string | null> {
  if (!leadId) return null;

  // 1) chats/messages
  try {
    const url = baseUrl("/api/v4/chats/messages");
    const params = { "filter[lead_id]": leadId, order: "desc", limit: 1 };
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
    // 404/403 son normales si la cuenta no expone este recurso
    console.warn("⚠️ chats/messages no disponible:", e?.response?.status, e?.response?.data || e?.message);
  }

  // 2) lead con last_message
  try {
    const url = baseUrl(`/api/v4/leads/${leadId}`);
    const params = { with: "last_message" };
    const { data } = await axios.get(url, { params, headers: authHeaders() });
    const t =
      data?.last_message?.text ??
      data?._embedded?.last_message?.text ??
      null;
    if (t && String(t).trim()) return String(t).trim();
  } catch (e: any) {
    console.warn("⚠️ lead.last_message no disponible:", e?.response?.status, e?.response?.data || e?.message);
  }

  // 3) última nota (como rescate; puede no ser el mensaje del cliente)
  try {
    const url = baseUrl(`/api/v4/notes`);
    const params = {
      "filter[entity]": "lead",
      "filter[entity_id]": leadId,
      order: "desc",
      limit: 1,
    };
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
