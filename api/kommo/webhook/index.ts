// api/kommo/webhook/index.ts
//import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(_req: any, res: any) {
  return res.status(404).send('Use /api/kommo/webhook/{SECRET}');
}