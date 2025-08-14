// agent-hub-brain-main/api/_lib/kommo.ts
// Utilidades Kommo: limpiar subdominio, continuar Salesbot y fallback por return_url.

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

type ContinueArgs = {
  subdomain: string;
  accessToken: string;
  botId: string | number;
  continueId: string | number;
  text: string;
  extraData?: Record<string, any>;
};

/**
 * Continúa el Salesbot y muestra el texto al usuario.
 * Además deja `data.reply` por si lo usas en pasos posteriores ({{json.reply}}).
 */
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
    execute_handlers: [{ handler: "show", params: { text } }], // muestra la respuesta
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
