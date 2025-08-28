// /api/brand.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { kvGet, kvSet } from './/_lib/redis';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || process.env.HUB_BRIDGE_SECRET || '';

type Ok = { ok: true; data?: any };
type Err = { ok: false; error: string; detail?: any };

function ensureSecret(req: NextApiRequest): boolean {
  const fromHeader = (req.headers['x-bridge-secret'] as string) || '';
  const fromQuery = (req.query?.secret as string) || '';
  return (WEBHOOK_SECRET && (fromHeader === WEBHOOK_SECRET || fromQuery === WEBHOOK_SECRET)) || false;
}

function computeTotal(items: any[] = [], fees: any[] = [], taxes: any[] = []) {
  const sum = (arr:any[], f:(x:any)=>number) => arr.reduce((a,b)=>a + (f(b)||0), 0);
  const itemsSubtotal = sum(items, it=>Number(it.qty||1)*Number(it.unitPrice||0));
  const feeTotal = sum(fees, it=>Number(it.amount||0));
  const taxTotal = sum(taxes, it=>Number(it.amount||0));
  return { itemsSubtotal, feeTotal, taxTotal, total: itemsSubtotal + feeTotal + taxTotal };
}

function goldCSS() {
  return `
    :root { --gold:#d4af37; --bg:#0a0a0a; --fg:#f5f5f5; --muted:#bbbbbb; }
    *{ box-sizing:border-box; }
    body{ margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background:#0a0a0a; color:var(--fg); }
    a{ color:var(--gold); }
    .wrap{ max-width:960px; margin:40px auto; padding:24px; }
    .brand{ display:flex; align-items:center; gap:12px; border-bottom:1px solid rgba(212,175,55,.35); padding-bottom:12px; margin-bottom:24px; }
    .brand .title{ font-size:28px; letter-spacing:2px; color:var(--gold); font-weight:600; }
    .card{ border:1px solid rgba(212,175,55,.35); border-radius:16px; padding:18px 20px; margin-bottom:16px; background:rgba(255,255,255,0.01); backdrop-filter: blur(2px); }
    .dayTitle{ color:var(--gold); font-weight:600; margin-bottom:4px; }
    .act{ margin:8px 0; padding-left:8px; border-left:2px solid rgba(212,175,55,.35); }
    .right{ border:1px solid rgba(212,175,55,.35); border-radius:16px; padding:16px; }
    .grid{ display:grid; grid-template-columns: 1fr 320px; gap:24px; }
    .priceRow{ display:flex; justify-content:space-between; margin:6px 0; color:var(--fg); }
    .muted{ color:var(--muted); font-size:13px; }
    .total{ font-size:28px; color:var(--gold); font-weight:700; text-align:right; padding-top:8px; border-top:1px dashed rgba(212,175,55,.35); margin-top:8px; }
    .cta{ display:flex; gap:12px; margin-top:16px; }
    .btn{ padding:12px 16px; border-radius:12px; border:1px solid rgba(212,175,55,.5); color:#0a0a0a; background:linear-gradient(180deg, #f7e8a8, #d4af37); font-weight:600; text-decoration:none; }
  `;
}

function escapeHTML(s:string){ return s.replace(/[&<>"]/g, (c)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' } as any)[c]); }

function renderItinerary(title:string, payload:any) {
  const days = Array.isArray(payload?.days)? payload.days: [];
  const baseCities = (payload?.cityBases||[]).join(' • ');
  const right = `<div class="right">
    <div class="muted">Base cities</div>
    <div style="margin-bottom:10px">${escapeHTML(baseCities)}</div>
    <div class="muted">Traveler</div>
    <div>${escapeHTML(String(payload?.travelerProfile||''))}</div>
  </div>`;

  const left = days.map((d:any)=>`
    <div class="card">
      <div class="dayTitle">DAY ${d.dayNumber} — ${escapeHTML(String(d.title||''))}</div>
      ${(d.date? `<div class="muted" style="margin-bottom:8px">${escapeHTML(d.date)}</div>`:'')}
      ${(Array.isArray(d.activities)? d.activities.map((a:any)=>`
        <div class="act">
          ${a.timeRange? `<div class="muted">${escapeHTML(a.timeRange)}</div>`:''}
          <div><strong>${escapeHTML(String(a.title||''))}</strong></div>
          ${a.description? `<div>${escapeHTML(a.description)}</div>`:''}
          ${a.logistics? `<div class="muted">${escapeHTML(a.logistics)}</div>`:''}
        </div>`).join(''): '')}
      ${d.notes? `<div class="muted" style="margin-top:6px">${escapeHTML(d.notes)}</div>`:''}
    </div>
  `).join('');

  return `
  <!doctype html>
  <html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHTML(title)}</title>
  <style>${goldCSS()}</style></head>
  <body><div class="wrap">
    <div class="brand"><div class="title">COCO VOLARE</div></div>
    <h1 style="margin:8px 0 16px 0">${escapeHTML(title)}</h1>
    <div class="grid">
      <div>${left}</div>
      ${right}
    </div>
  </div></body></html>`;
}

function renderQuote(title:string, payload:any) {
  const { items=[], fees=[], taxes=[], currency='USD' } = payload || {};
  const sums = computeTotal(items, fees, taxes);

  function row(label:string, amount:number) {
    return `<div class="priceRow"><div>${escapeHTML(label)}</div><div>${escapeHTML(currency)} ${amount.toFixed(2)}</div></div>`;
  }
  const itemsHtml = items.map((it:any)=> row(String(it.label||it.sku||'Item'), Number(it.qty||1)*Number(it.unitPrice||0))).join('');
  const feesHtml = fees.map((f:any)=> row(String(f.label||'Fee'), Number(f.amount||0))).join('');
  const taxHtml = taxes.map((t:any)=> row(String(t.label||'Tax'), Number(t.amount||0))).join('');
  const right = `<div class="right">
    <div class="muted">Currency</div><div>${escapeHTML(currency)}</div>
    <div class="muted" style="margin-top:8px">Validity</div><div>${escapeHTML(payload?.validity||'48h')}</div>
    <div class="total">${escapeHTML(currency)} ${sums.total.toFixed(2)}</div>
  </div>`;

  const left = `<div class="card">
    <div class="dayTitle">Price Summary</div>
    ${itemsHtml}${feesHtml}${taxHtml}
  </div>`;

  return `
  <!doctype html>
  <html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHTML(title)}</title>
  <style>${goldCSS()}</style></head>
  <body><div class="wrap">
    <div class="brand"><div class="title">COCO VOLARE</div></div>
    <h1 style="margin:8px 0 16px 0">${escapeHTML(title)}</h1>
    <div class="grid">
      <div>${left}</div>
      ${right}
    </div>
  </div></body></html>`;
}

function makeId() { return crypto.randomBytes(8).toString('hex'); }

export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok|Err>) {
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, data: { pong: true } });
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ ok:false, error:'method_not_allowed' });
    }
    if (!ensureSecret(req)) {
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const action = String(body?.action||'');
    if (action === 'price-quote') {
      const items = Array.isArray(body?.items) ? body.items : [];
      const fees = Array.isArray(body?.fees) ? body.fees : [];
      const taxes = Array.isArray(body?.taxes) ? body.taxes : [];
      const currency = String(body?.currency || 'USD');
      const validity = String(body?.validity || '48h');
      const totals = computeTotal(items, fees, taxes);
      const data = { currency, items, fees, taxes, ...totals, validity, termsTemplateId: body?.termsTemplateId || 'CV-TERMS-STD-01' };
      return res.status(200).json({ ok:true, data });
    }

    if (action === 'render-document') {
      const kind = String(body?.kind||'itinerary');
      const title = String(body?.title||'Propuesta Coco Volare');
      const payload = body?.payload || {};
      let html = '';
      if (kind === 'quote') html = renderQuote(title, payload);
      else html = renderItinerary(title, payload);

      const id = makeId();
      await kvSet(`cv:doc:${id}`, html, 60 * 60 * 24 * 7); // 7 days
      const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
      const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';
      const base = `${proto}://${host}`;
      const url = `${base}/api/brand/view/${id}`;
      return res.status(200).json({ ok:true, data: { id, url } });
    }

    return res.status(400).json({ ok:false, error: 'unknown_action' });
  } catch (e:any) {
    return res.status(500).json({ ok:false, error:'exception', detail:String(e?.message||e) });
  }
}
