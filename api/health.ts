import type { IncomingMessage, ServerResponse } from 'http';

export default function handler(_req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({ ok: true, ts: Date.now() }));
}
