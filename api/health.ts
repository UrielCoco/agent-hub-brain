// agent-hub-brain/api/health.ts
export default async function handler(_req: any, res: any) {
  res.status(200).json({ ok: true, ts: Date.now() });
}
