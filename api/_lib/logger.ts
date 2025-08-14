export function genTraceId() {
  return "t" + Math.random().toString(36).slice(2);
}
export function mkLogger(traceId?: string) {
  function out(level: "info" | "warn" | "error", msg: string, meta?: any) {
    const payload = { time: new Date().toISOString(), level, traceId, msg, meta };
    console.log(JSON.stringify(payload));
  }
  return {
    info: (m: string, meta?: any) => out("info", m, meta),
    warn: (m: string, meta?: any) => out("warn", m, meta),
    error: (m: string, meta?: any) => out("error", m, meta),
    debug: (m: string, meta?: any) => out("info", m, meta),
  };
}
