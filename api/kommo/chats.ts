import crypto from "crypto";
import fetch from "node-fetch";

type SendMessageArgs = {
  scopeId: string;             // del connect
  body: Record<string, any>;   // payload "new_message"
  channelSecret: string;       // secret del canal (no el client secret OAuth)
};

function rfc2822Date(d = new Date()) {
  return d.toUTCString(); // "Thu, 01 Jan 2025 12:00:00 GMT"
}

function md5Body(json: string) {
  return crypto.createHash("md5").update(json, "utf8").digest("hex");
}

function sign({
  method,
  date,
  contentMd5,
  path,              // sin dominio y sin query, p.ej. `/v2/origin/custom/{scope_id}`
  channelSecret
}: {
  method: "POST" | "GET";
  date: string;
  contentMd5: string;
  path: string;
  channelSecret: string;
}) {
  const signingString = [method, date, contentMd5, path].join("\n");
  return crypto.createHmac("sha1", channelSecret).update(signingString).digest("hex");
}

export async function kommoSendMessage({ scopeId, body, channelSecret }: SendMessageArgs) {
  const url = `https://amojo.kommo.com/v2/origin/custom/${scopeId}`;
  const path = `/v2/origin/custom/${scopeId}`;
  const json = JSON.stringify(body);
  const date = rfc2822Date();
  const contentMd5 = md5Body(json);
  const signature = sign({
    method: "POST",
    date,
    contentMd5,
    path,
    channelSecret
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Date": date,
      "Content-Type": "application/json",
      "Content-MD5": contentMd5,
      "X-Signature": signature
    },
    body: json
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kommo amojo error ${res.status}: ${text}`);
  }
  return res.json();
}
