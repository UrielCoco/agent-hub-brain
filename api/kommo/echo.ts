import type { VercelRequest, VercelResponse } from "@vercel/node";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

function tid() {
  return "echo_" + Math.random().toString(36).slice(2);
}

function log(
  level: "info" | "warn" | "error",
  msg: string,
  meta?: any,
  traceId?: string
) {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), level, traceId, msg, meta })
  );
}

/** Intenta normalizar el body venga como JSON o x-www-form-urlencoded */
function normalizeBody(req: VercelRequest) {
  const ct = String(req.headers["content-type"] || "");
  const raw = typeof req.body === "string" ? req.body : "";

  if (ct.includes("application/json")) {
    if (typeof req.body === "string") {
      try {
        return JSON.parse(req.body);
      } catch {
        return { raw: req.body };
      }
    }
    return req.body || {};
  }

  if (ct.includes("application/x-www-form-urlencoded")) {
    try {
      const params = new URLSearchParams(raw);
      const obj: any = {};
      params.forEach((v, k) => (obj[k] = v));
      return obj;
    } catch {
      return req.body || {};
    }
  }

  // Fallback (Next/Vercel puede ya haber parseado)
  return req.body || {};
}

/** Intenta extraer el texto del mensaje de varias formas comunes */
function pickMessage(body: any): string {
  return (
    body?.message?.text ??
    body?.message ??
    body?.data?.message ??
    body?.message_text ??
    ""
  ).toString();
}

/** Extrae return_url si viene (formato Private Chatbot) */
function pickReturnUrl(body: any): string | undefined {
  return body?.return_url || body?.data?.return_url || body?.callback_url;
}

/** Postea a return_url con el formato que espera Kommo (private chatbot) */
async function postReturn(
  returnUrl: string,
  payload: { data?: any; execute_handlers?: any[] },
  traceId: string
) {
  const resp = await fetch(returnUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      data: payload.data ?? {},
      execute_handlers: payload.execute_handlers ?? [],
    }),
  });
  const preview = await resp.text().catch(() => "");
  log(
    "info",
    "return_url ← resp",
    { status: resp.status, len: preview.length, preview: preview.slice(0, 160) },
    traceId
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const traceId = tid();

  try {
    const ct = String(req.headers["content-type"] || "");
    const len = Number(req.headers["content-length"] || 0);

    const body = normalizeBody(req);
    const keys = Object.keys(body || {});

    log("info", "ECHO:received", { method: req.method, url: req.url, ct, len, keys }, traceId);

    // Detección de payload "Global" por si por error lo apuntan aquí
    if (keys.some((k) => k.startsWith("message[add][0]"))) {
      log(
        "warn",
        "ECHO:payload_looks_like_global",
        {
          hint: "Este endpoint es para pruebas/chatbot. Deja el Webhook Global en /api/kommo/global.",
        },
        traceId
      );
    }

    const text = pickMessage(body);
    const returnUrl = pickReturnUrl(body);

    log(
      "info",
      "ECHO:body",
      {
        messagePreview: text.slice(0, 200),
        hasReturnUrl: !!returnUrl,
      },
      traceId
    );

    // Payload que Kommo entiende para continuar el bot (mostrar texto)
    const payload = {
      data: { status: "success", echo: true },
      execute_handlers: [
        { handler: "show", params: { type: "text", value: `ECHO ▶ ${text || "👋 sin 'message'"}` } },
      ],
    };

    // MODO 1: Private Chatbot (Kommo nos manda return_url) -> fire-and-forget
    if (returnUrl) {
      // Dispara el continue y responde el ACK inmediato (<2s)
      postReturn(returnUrl, payload, traceId).catch((e) => {
        log("error", "return_url:error", { err: String(e) }, traceId);
      });
      return res.status(200).json({ status: "ok", traceId });
    }

    // MODO 2: widget_request (sin return_url) → respondemos inline
    return res.status(200).json(payload);
  } catch (e: any) {
    log("error", "ECHO:error", { err: e?.message || String(e) }, traceId);
    // Regresa 200 con status "error" para que Kommo no falle el bloque
    return res.status(200).json({ data: { status: "error" } });
  }
}
