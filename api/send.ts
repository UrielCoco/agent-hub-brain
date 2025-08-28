// pages/api/send.ts – FULL FILE (Pages Router)
import type { NextApiRequest, NextApiResponse } from "next";

function assertSecret(req: NextApiRequest) {
  if ((process.env.HUB_BRAIN_SECRET || "") !== (req.headers["x-hub-secret"] || "")) {
    throw new Error("unauthorized");
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    assertSecret(req);
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { to, channel, docUrl, message } = req.body || {};

    // Placeholder implementation.
    // Integrate with your email provider or WhatsApp API (e.g., Twilio/Meta).
    console.log("SEND:", { to, channel, docUrl, message });

    return res.status(200).json({ ok: true, channel });
  } catch (e: any) {
    const msg = e?.message || "error";
    const code = msg === "unauthorized" ? 401 : 500;
    return res.status(code).json({ error: msg });
  }
}
