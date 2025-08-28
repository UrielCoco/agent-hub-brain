// pages/api/quote.ts – FULL FILE (Pages Router)
import type { NextApiRequest, NextApiResponse } from "next";

function assertSecret(req: NextApiRequest) {
  if ((process.env.HUB_BRAIN_SECRET || "") !== (req.headers["x-hub-secret"] || "")) {
    throw new Error("unauthorized");
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    assertSecret(req);
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { destination, startDate, endDate, pax, category, extras, currency } = req.body || {};

    // Demo pricing: replace with consolidators/DB
    const nightly = category === "5S" ? 280 : category === "4S" ? 180 : 120;
    const nights = Math.max(1, Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000));
    const hotelSubtotal = nightly * nights * pax;
    const toursSubtotal = 150 * pax; // placeholder
    const items = [
      { sku: "HTL", label: `Hotel ${category}`, qty: pax, unitPrice: nightly * nights, subtotal: hotelSubtotal },
      { sku: "TOUR", label: "Tours/Experiencias", qty: pax, unitPrice: 150, subtotal: toursSubtotal },
    ];

    const fees = [{ label: "Fee de agencia", amount: 50 }];
    const taxes = [{ label: "Impuestos", amount: Math.round((hotelSubtotal + toursSubtotal + 50) * 0.16) }];
    const total = items.reduce((a,b)=>a+b.subtotal,0) + fees[0].amount + taxes[0].amount;

    const quote = {
      currency: currency || "USD",
      items, fees, taxes, total,
      validity: "48h",
      termsTemplateId: "CV-TERMS-STD-01",
    };

    return res.status(200).json({ quote });
  } catch (e: any) {
    const msg = e?.message || "error";
    const code = msg === "unauthorized" ? 401 : 500;
    return res.status(code).json({ error: msg });
  }
}
