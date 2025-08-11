// agent-hub-brain/src/services/kommo.ts
import axios, { AxiosRequestConfig } from "axios";
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

/** Crea una Nota "common" en el lead */
export async function postNoteToLead(leadId: number, text: string): Promise<void> {
  if (!leadId || !text) throw new Error("leadId/text required");
  const url = apiV4Url(`leads/${leadId}/notes`);
  const body = { note_type: "common", params: { text } };
  const cfg: AxiosRequestConfig = { headers: { ...authHeaders(), "Content-Type": "application/json" } };
  logRequest("POST", url, { bodyPreview: { note_type: "common", textLen: text.length } });
  await axios.post(url, body, cfg);
}

/**
 * Fallback: obtener último "texto útil" del lead.
 * Estrategia:
 *  1) /api/v4/leads/{id}?with=last_message
 *  2) /api/v4/leads/{id}/notes?order=desc&limit=3  → tomamos la primera nota "common" con texto
 */
export async function getLatestMessageForLead(leadId: number): Promise<string | null> {
  if (!leadId) return null;

  // 1) lead.last_message
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

  // 2) últimas notas del lead
  try {
    const url = apiV4Url(`leads/${leadId}/notes`);
    const params = { order: "desc", limit: 3 };
    logRequest("GET", url, { params });
    const { data } = await axios.get(url, { params, headers: authHeaders() });
    const notes = data?._embedded?.notes || data?.notes || [];
    if (Array.isArray(notes) && notes.length > 0) {
      for (const n of notes) {
        const isCommon =
          n?.note_type === "common" ||
          n?.type === "common" ||
          n?.params?.text; // algunos devuelven solo params
        const text =
          n?.params?.text ??
          n?.text ??
          null;
        if (isCommon && text && String(text).trim()) {
          return String(text).trim();
        }
      }
    }
  } catch (e: any) {
    console.warn("⚠️ leads/{id}/notes no disponible:", e?.response?.status, e?.response?.data || e?.message);
  }

  return null;
}
