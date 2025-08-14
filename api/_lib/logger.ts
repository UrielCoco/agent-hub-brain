// api/_lib/logger.ts
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const CUR = (process.env.LOG_LEVEL as LogLevel) || "info";
const CURN = LEVELS[CUR] ?? 20;

export function mkLogger(traceId?: string) {
  const tid = traceId || genTraceId();
  function log(level: LogLevel, msg: string, meta?: any) {
    if (LEVELS[level] < CURN) return;
    const time = new Date().toISOString();
    // Evita petar logs por objetos gigantes
    const safeMeta = meta ? safe(meta) : undefined;
    console.log(JSON.stringify({ time, level, traceId: tid, msg, ...(safeMeta ? { meta: safeMeta } : {}) }));
  }
  return {
    traceId: tid,
    debug: (m: string, x?: any) => log("debug", m, x),
    info:  (m: string, x?: any) => log("info",  m, x),
    warn:  (m: string, x?: any) => log("warn",  m, x),
    error: (m: string, x?: any) => log("error", m, x),
  };
}

export function genTraceId() {
  return `t${Date.now().toString(36)}${Math.floor(Math.random()*1e6).toString(36)}`;
}

function safe(x: any) {
  try {
    return prune(x);
  } catch { return { note: "meta-serialize-failed" }; }
}

function prune(x: any, depth = 0): any {
  if (x == null) return x;
  if (depth > 3) return "...";
  if (typeof x === "string") return x.length > 500 ? `${x.slice(0,500)}...(${x.length})` : x;
  if (typeof x !== "object") return x;
  if (Array.isArray(x)) return x.slice(0,20).map(v => prune(v, depth+1));
  const out: any = {};
  const keys = Object.keys(x).slice(0, 30);
  for (const k of keys) out[k] = prune(x[k], depth+1);
  return out;
}
