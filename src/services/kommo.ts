import axios from "axios";
import { KOMMO_BASE_URL, KOMMO_ACCESS_TOKEN } from "../config.js";

function headers() {
  return {
    Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
}

export async function postNoteToLead(leadId: number, text: string) {
  if (!KOMMO_BASE_URL) throw new Error("Missing KOMMO_BASE_URL");
  if (!KOMMO_ACCESS_TOKEN) throw new Error("Missing KOMMO_ACCESS_TOKEN");

  const url = `${KOMMO_BASE_URL}/api/v4/leads/${leadId}/notes`;
  await axios.post(
    url,
    { note_type: "common", params: { text } },
    { headers: headers() }
  );
}
