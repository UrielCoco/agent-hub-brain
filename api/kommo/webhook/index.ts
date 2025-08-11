// api/kommo/webhook/index.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  return res.status(404).send('Use /api/kommo/webhook/{SECRET}');
}