// pages/api/render.ts – FULL FILE (Pages Router)
import type { NextApiRequest, NextApiResponse } from "next";

function assertSecret(req: NextApiRequest) {
  if ((process.env.HUB_BRAIN_SECRET || "") !== (req.headers["x-hub-secret"] || "")) {
    throw new Error("unauthorized");
  }
}

// For demo we produce a signed data URL-ish HTML blob. In production render to object storage.
function renderHtml(templateId: string, payload: any) {
  // Minimal brand HTML (black + gold)
  const title = templateId.startsWith("CV-") ? "Coco Volare – Propuesta" : "Documento";
  return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>${title}</title>
<style>
  body{background:#0b0b0b;color:#fff;font-family:-apple-system,Segoe UI,Roboto,Arial;padding:24px}
  .brand{color:#C9A34B;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px}
  .card{border:1px solid #3a2d10;border-radius:14px;padding:16px;margin:12px 0;background:#101010}
  .grid{display:grid;grid-template-columns:1fr 320px;gap:16px}
  .btn{display:inline-block;background:#C9A34B;color:#0b0b0b;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:700}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
  <h1 class="brand">${title}</h1>
  <div class="grid">
    <div class="card"><pre>${JSON.stringify(payload, null, 2)}</pre></div>
    <div class="card"><strong>Template:</strong> ${templateId}<br/><br/>
      <a class="btn" download="Coco-Volare.html" href="data:text/html;charset=utf-8,${encodeURIComponent("<pre>"+JSON.stringify(payload,null,2)+"</pre>")}">Descargar</a>
    </div>
  </div>
</body></html>`;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    assertSecret(req);
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const { templateId, payloadJson, output, fileName } = req.body || {};

    const html = renderHtml(templateId, payloadJson);
    // In production upload to S3/GCS and return a signed URL.
    const base64 = Buffer.from(html, "utf8").toString("base64");
    const url = `data:text/html;base64,${base64}`;
    return res.status(200).json({ url, html });
  } catch (e: any) {
    const msg = e?.message || "error";
    const code = msg === "unauthorized" ? 401 : 500;
    return res.status(code).json({ error: msg });
  }
}
