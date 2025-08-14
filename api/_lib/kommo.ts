// api/_lib/kommo.ts
import { mkLogger } from "./logger";

export function cleanSubdomain(value?: string): string {
  if (!value) return "";
  return String(value)
    .replace(/^https?:\/\//, "")
    .replace(/\.amocrm\.com.*$/i, "")
    .replace(/\.kommo\.com.*$/i, "")
    .replace(/\/.*$/, "");
}

function kommoBase(subdomain: string) {
  return `https://${subdomain}.kommo.com`;
}
function kommoBaseFromEnv() {
  const base = process.env.KOMMO_BASE_URL || "";
  if (base) return base.replace(/\/+$/,"");
  const sub = process.env.KOMMO_SUBDOMAIN || "";
  return sub ? `https://${cleanSubdomain(sub)}.kommo.com` : "";
}

type ContinueArgs = {
  subdomain: string;
  accessToken: string;
  botId: string | number;
  continueId: string | number;
  text: string;
  extraData?: Record<string, any>;
  traceId?: string;
};

/** Continúa el Salesbot y pide que muestre el texto al usuario */
export async function continueSalesbot(args: ContinueArgs) {
  const { subdomain, accessToken, botId, continueId, text, extraData = {}, traceId } = args;
  const log = mkLogger(traceId);

  if (!subdomain || !accessToken || !botId || !continueId) {
    log.error("continueSalesbot missing params", { subdomain, hasToken: !!accessToken, botId, continueId });
    throw new Error("continueSalesbot: faltan parámetros");
  }

  const url = `${kommoBase(subdomain)}/api/v4/salesbot/${botId}/continue/${continueId}`;
  const body = {
    data: { status: "success", reply: text, ...extraData },
    execute_handlers: [{ handler: "show", params: { text } }],
  };

  log.info("continueSalesbot → POST", { url, textPreview: String(text).slice(0,80) });

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const txt = await res.text().catch(() => "");
  log.info("continueSalesbot ← resp", { status: res.status, len: txt.length, preview: txt.slice(0,200) });

  if (!res.ok) throw new Error(`Salesbot continue failed ${res.status}: ${txt}`);
}

/** Fallback: continuar con return_url que envía Kommo en widget_request */
export async function continueViaReturnUrl(returnUrl: string, dataObj: any, traceId?: string) {
  const log = mkLogger(traceId);
  log.info("return_url → POST", { returnUrl, dataPreview: JSON.stringify(dataObj).slice(0,120) });

  const r = await fetch(returnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: dataObj }),
  });

  const txt = await r.text().catch(() => "");
  log.info("return_url ← resp", { status: r.status, len: txt.length, preview: txt.slice(0,200) });

  if (!r.ok) throw new Error(`return_url failed ${r.status}: ${txt}`);
}

/** Nota en Lead (útil p/ auditoría) */
export async function addLeadNote(leadId: number, text: string, traceId?: string) {
  const log = mkLogger(traceId);
  const base = kommoBaseFromEnv();
  const token = process.env.KOMMO_ACCESS_TOKEN;
  if (!base || !token) {
    log.warn("addLeadNote missing base/token", { base: !!base, token: !!token });
    return;
  }
  const url = `${base}/api/v4/leads/notes`;
  const payload = [{ entity_id: Number(leadId), note_type: "common", params: { text: String(text || "") } }];

  log.debug("addLeadNote → POST", { url, leadId, textPreview: text.slice(0,120) });

  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const txt = await r.text().catch(() => "");
  log.debug("addLeadNote ← resp", { status: r.status, preview: txt.slice(0,200) });

  if (!r.ok) throw new Error(`addLeadNote failed ${r.status}: ${txt}`);
}
