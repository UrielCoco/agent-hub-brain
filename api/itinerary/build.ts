// pages/api/itinerary/build.ts – FULL FILE (Pages Router)
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

    const { travelerProfile, cityBases, days, currency, brandMeta } = req.body || {};
    // Simple demo builder – in real life pull attractions/times from DB
    const outDays = Array.from({ length: days }).map((_, i) => ({
      dayNumber: i + 1,
      title: i === 0 ? `Llegada a ${cityBases[0]}` : `Día libre / Actividades sugeridas`,
      breakfastIncluded: true,
      activities: [
        {
          timeRange: i === 0 ? "Llegada" : "10:00 - 13:00",
          title: i === 0 ? "Traslado al hotel" : "City Walk & Highlights",
          description: i === 0
            ? "Recepción en aeropuerto y traslado en vehículo privado al hotel seleccionado."
            : "Recorrido a pie por puntos emblemáticos y miradores. Recomendaciones gastronómicas.",
          logistics: i === 0 ? "Pick-up: Aeropuerto" : "Pick-up: Hotel",
        },
      ],
    }));

    const itinerary = {
      brandMeta,
      travelerProfile,
      currency,
      cityBases,
      days: outDays,
    };

    return res.status(200).json({ itinerary });
  } catch (e: any) {
    const msg = e?.message || "error";
    const code = msg === "unauthorized" ? 401 : 500;
    return res.status(code).json({ error: msg });
  }
}
