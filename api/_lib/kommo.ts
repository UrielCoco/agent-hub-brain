// agent-hub-brain-main-2/api/_lib/kommo.ts
// Utilidades Kommo: limpiar subdominio, continuar Salesbot, return_url y notas en lead.

export function cleanSubdomain(value?: string): string {
  if (!value) return "";
  return String(value)
    .replace(/^https?:\/\//, "")
    .replace(/\.amocrm\.com.*$/i, "")
    .replace(/\.kommo\.com.*$/i, "")
    .replace(/\/.*$/, "");
}

function kommoBaseFromEnv() {
  const base = process.env.KOMMO_BASE_URL || "";
  if (base) return base.replace(/\/+$/,"");
  const sub = process.env.KOMMO_SUBDOMAIN || "";
  return sub ? `https://${cleanSubdomain(sub)}.kommo.com` : "";
}

function kommoBase(subdomain: string) {
  return `https://${subdomain}.kommo.com`;
}

type ContinueArgs = {
  subdomain: string;
  accessToken: string;
  botId: string | number;
  continueId: string | number;
  text: string;
  extraData?: Record<string, any>;
};

/** Continúa el Salesbot y muestra el texto al usuario (handler show). */
export async function continueSalesbot({
  subdomain,
  accessToken,
  botId,
  continueId,
  text,
  extraData = {},
}: ContinueArgs) {
  if (!subdomain || !accessToken || !botId || !continueId) {
    throw new Error("continueSalesbot: faltan parámetros");
  }

  const url = `${kommoBase(subdomain)}/api/v4/salesbot/${botId}/continue/${continueId}`;
  const body = {
    data: { status: "success", reply: text, ...extraData },
    execute_handlers: [{ handler: "show", params: { text } }],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Salesbot continue failed ${res.status}: ${errText}`);
  }
}

/** Fallback oficial: reanuda con la URL que envía Kommo en el widget_request */
export async function continueViaReturnUrl(returnUrl: string, dataObj: any) {
  const r = await fetch(returnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: dataObj }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`return_url failed ${r.status}: ${errText}`);
  }
}

/** Agrega una nota a un Lead (v4) */
export async function addLeadNote(leadId: number, text: string) {
  const base = kommoBaseFromEnv();
  const token = process.env.KOMMO_ACCESS_TOKEN;
  if (!base || !token) throw new Error("addLeadNote: falta KOMMO_BASE_URL/KOMMO_SUBDOMAIN o KOMMO_ACCESS_TOKEN");

  const url = `${base}/api/v4/leads/notes`;
  const payload = [
    {
      entity_id: Number(leadId),
      note_type: "common",
      params: { text: String(text || "") },
    },
  ];

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const err = await r.text().catch(() => "");
    throw new Error(`addLeadNote failed ${r.status}: ${err}`);
  }

  return r.json().catch(() => ({}));
}
