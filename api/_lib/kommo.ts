const BASE = process.env.KOMMO_BASE_URL!;
const AUTH = `Bearer ${process.env.KOMMO_ACCESS_TOKEN!}`;

function must(v?: string, name?: string) {
  if (!v) throw new Error(`Falta variable: ${name}`);
  return v;
}

async function kommoFetch(path: string, init: RequestInit = {}) {
  must(BASE, 'KOMMO_BASE_URL'); must(AUTH, 'KOMMO_ACCESS_TOKEN');
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { 'Authorization': AUTH, 'Content-Type': 'application/json', ...(init.headers || {}) },
    cache: 'no-store'
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=>'');
    throw new Error(`Kommo ${path} -> ${res.status}: ${txt}`);
  }
  return res;
}

export async function addLeadNote(leadId: number, text: string) {
  const body = [{ note_type: 'common', params: { text } }];
  await kommoFetch(`/api/v4/leads/${leadId}/notes`, { method: 'POST', body: JSON.stringify(body) });
}

export async function updateLead(leadId: number, patch: any) {
  const res = await kommoFetch(`/api/v4/leads/${leadId}`, { method: 'PATCH', body: JSON.stringify(patch) });
  return res.json();
}
