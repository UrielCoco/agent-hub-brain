// lib/kommo.js
// Utilidades para continuar el Salesbot y fallback por return_url

export function cleanSubdomain(value) {
  if (!value) return "";
  // quita https:// y dominio
  return String(value)
    .replace(/^https?:\/\//, "")
    .replace(/\.amocrm\.com.*$/i, "")
    .replace(/\/.*$/, "");
}

export async function continueSalesbot({ subdomain, accessToken, botId, continueId, text }) {
  if (!subdomain || !accessToken || !botId || !continueId) {
    throw new Error("continueSalesbot: faltan parámetros");
  }
  const url = `https://${subdomain}.kommo.com/api/v4/salesbot/${botId}/continue/${continueId}`;

  const body = {
    // Esto aparece en {{json.*}} si lo necesitas
    data: { status: "success", reply: text },
    // Y aquí pedimos que el bot "muestre" el texto al cliente
    execute_handlers: [{ handler: "show", params: { text } }],
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`Salesbot continue failed ${r.status}: ${errText}`);
  }
}

export async function continueViaReturnUrl(returnUrl, dataObj) {
  const r = await fetch(returnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // La spec pide un objeto con "data"
    body: JSON.stringify({ data: dataObj }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`return_url failed ${r.status}: ${errText}`);
  }
}
