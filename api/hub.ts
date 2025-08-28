// api/hub.ts — ÚNICA función del Hub (Vercel Serverless/Edge-friendly)
// - Sin imports de 'next' ni 'node-fetch'
// - Usa Web Request/Response nativos
// - Action Router: itinerary.build | quote | render | send
// - Header requerido: x-hub-secret = process.env.HUB_BRAIN_SECRET

export const config = { runtime: "edge" }; // o quítalo si prefieres Node runtime

type Json = Record<string, any>;

function json(status: number, data: Json) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function assertSecret(req: Request) {
  const secret = (process.env.HUB_BRAIN_SECRET || "").trim();
  const got = (req.headers.get("x-hub-secret") || "").trim();
  if (!secret || !got || secret !== got) throw new Error("unauthorized");
}

async function itineraryBuild(payload: any) {
  const { travelerProfile, cityBases, days, currency, brandMeta } = payload || {};
  const n = Math.max(1, Math.min(31, Number(days || 1)));
  const outDays = Array.from({ length: n }).map((_, i) => ({
    dayNumber: i + 1,
    title: i === 0 ? `Llegada a ${cityBases?.[0] || "destino"}` : `Día libre / Actividades sugeridas`,
    breakfastIncluded: true,
    activities: [
      {
        timeRange: i === 0 ? "Llegada" : "10:00 - 13:00",
        title: i === 0 ? "Traslado al hotel" : "City Walk & Highlights",
        description:
          i === 0
            ? "Recepción en aeropuerto y traslado privado al hotel seleccionado."
            : "Recorrido por puntos emblemáticos y recomendaciones gastronómicas.",
        logistics: i === 0 ? "Pick-up: Aeropuerto" : "Pick-up: Hotel",
      },
    ],
  }));

  const itinerary = {
    brandMeta,
    travelerProfile,
    currency: currency || "USD",
    cityBases: Array.isArray(cityBases) ? cityBases : [],
    days: outDays,
  };
  return { itinerary };
}

function dateDiffDays(a: string, b: string) {
  const t1 = new Date(a).getTime();
  const t2 = new Date(b).getTime();
  if (isNaN(t1) || isNaN(t2)) return 1;
  return Math.max(1, Math.ceil((t2 - t1) / 86400000));
}

async function quote(payload: any) {
  const { destination, startDate, endDate, pax, category, extras, currency } = payload || {};
  const nights = dateDiffDays(startDate, endDate);
  const nightly = category === "5S" ? 280 : category === "4S" ? 180 : 120;
  const p = Math.max(1, Number(pax || 1));

  const hotelSubtotal = nightly * nights * p;
  const toursSubtotal = 150 * p;
  const items = [
    { sku: "HTL", label: `Hotel ${category || "4S"}`, qty: p, unitPrice: nightly * nights, subtotal: hotelSubtotal },
    { sku: "TOUR", label: "Tours/Experiencias", qty: p, unitPrice: 150, subtotal: toursSubtotal },
  ];

  const fees = [{ label: "Fee de agencia", amount: 50 }];
  const taxesBase = hotelSubtotal + toursSubtotal + fees[0].amount;
  const taxes = [{ label: "Impuestos", amount: Math.round(taxesBase * 0.16) }];
  const total = items.reduce((a, b) => a + b.subtotal, 0) + fees[0].amount + taxes[0].amount;

  const out = {
    currency: currency || "USD",
    items,
    fees,
    taxes,
    total,
    validity: "48h",
    termsTemplateId: "CV-TERMS-STD-01",
    destination: destination || "",
    nights,
  };
  return { quote: out };
}

function renderHtml(templateId: string, payload: any) {
  const title = "Coco Volare – Propuesta";
  const pretty = JSON.stringify(payload, null, 2);
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${title}</title>
<style>
body{background:#0b0b0b;color:#fff;font-family:-apple-system,Segoe UI,Roboto,Arial;padding:24px}
.brand{color:#C9A34B;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px}
.card{border:1px solid #3a2d10;border-radius:14px;padding:16px;margin:12px 0;background:#101010}
.grid{display:grid;grid-template-columns:1fr 320px;gap:16px}
.btn{display:inline-block;background:#C9A34B;color:#0b0b0b;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:700}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
pre{white-space:pre-wrap;word-wrap:break-word}
</style></head>
<body>
  <h1 class="brand">${title}</h1>
  <div class="grid">
    <div class="card"><pre>${pretty}</pre></div>
    <div class="card"><strong>Template:</strong> ${templateId}</div>
  </div>
</body></html>`;
}

async function render(payload: any) {
  const { templateId, payloadJson, output } = payload || {};
  const html = renderHtml(templateId || "CV-LUX-01", payloadJson);
  const base64 = Buffer.from(html, "utf8").toString("base64");
  const url = `data:text/html;base64,${base64}`;
  if ((output || "html") === "html") {
    return { url, html };
  }
  // Si luego generas PDF real, regrésalo aquí
  return { url };
}

async function send(payload: any) {
  const { to, channel, docUrl, message } = payload || {};
  // Integra con tu proveedor real (Email/WhatsApp). Por ahora log.
  console.log("SEND", { to, channel, docUrl, message });
  return { ok: true, channel: channel || "email" };
}

export default async function handler(req: Request): Promise<Response> {
  try {
    assertSecret(req);

    if (req.method !== "POST") return json(405, { error: "Method not allowed" });

    const ct = req.headers.get("content-type") || "";
    let body: any = {};
    if (ct.includes("application/json")) {
      body = await req.json();
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      const form = await req.formData();
      form.forEach((v, k) => (body[k] = v));
    }

    const action = String(body.action || "").toLowerCase();

    if (action === "itinerary.build") {
      const out = await itineraryBuild(body.payload || {});
      return json(200, out);
    }

    if (action === "quote") {
      const out = await quote(body.payload || {});
      return json(200, out);
    }

    if (action === "render") {
      const out = await render(body.payload || {});
      return json(200, out);
    }

    if (action === "send") {
      const out = await send(body.payload || {});
      return json(200, out);
    }

    return json(400, { error: "unknown_action", hint: "Use action: itinerary.build | quote | render | send" });
  } catch (e: any) {
    const msg = e?.message || "error";
    const code = msg === "unauthorized" ? 401 : 500;
    return json(code, { error: msg });
  }
}
