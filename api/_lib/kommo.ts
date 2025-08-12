// /api/_lib/kommo.ts
const BASE = process.env.KOMMO_BASE_URL!;
const AUTH = `Bearer ${process.env.KOMMO_ACCESS_TOKEN!}`;

async function kommoFetch(path: string, init: RequestInit = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Authorization': AUTH,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(init.headers || {})
    },
    cache: 'no-store'
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Kommo ${path} -> ${res.status} ${txt}`);
  }
  return res;
}

export async function addLeadNote(leadId: number, text: string) {
  // Crear notas (bulk) en Kommo v4
  const body = [
    { entity_id: Number(leadId), note_type: 'common', params: { text } }
  ];
  await kommoFetch(`/api/v4/leads/notes`, { method: 'POST', body: JSON.stringify(body) });
}

export async function updateLead(leadId: number, patch: any) {
  const r = await kommoFetch(`/api/v4/leads/${leadId}`, { method: 'PATCH', body: JSON.stringify(patch) });
  return r.json();
}
