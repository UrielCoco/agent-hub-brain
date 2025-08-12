// /api/_debug/echo.ts
import type { IncomingMessage, ServerResponse } from 'http';

export default async function handler(
  req: IncomingMessage & { url?: string; headers: any },
  res: ServerResponse
) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();

  
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    method: req.method,
    url: req.url,
    headers: req.headers,
    rawBody: raw
  }));
}
