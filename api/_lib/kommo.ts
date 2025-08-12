const BASE = process.env.KOMMO_BASE_URL!;
const AUTH = `Bearer ${process.env.KOMMO_ACCESS_TOKEN!}`;

async function kommoFetch(path: string, init: RequestInit = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, { ...init, headers: { 'Authorization':AUTH, 'Content-Type':'application/json', ...(init.headers||{}) }, cache:'no-store' });
  if (!res.ok) throw new Error(`Kommo ${path} -> ${res.status} ${await res.text().catch(()=> '')}`);
  return res;
}
export async function addLeadNote(leadId:number, text:string) {
  await kommoFetch(`/api/v4/leads/${leadId}/notes`, { method:'POST', body: JSON.stringify([{ note_type:'common', params:{ text } }]) });
}
export async function updateLead(leadId:number, patch:any) {
  const r = await kommoFetch(`/api/v4/leads/${leadId}`, { method:'PATCH', body: JSON.stringify(patch) }); return r.json();
}
