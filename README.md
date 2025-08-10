# Coco Volare — Agent Hub (Arquitectura 1: Hub Cerebro)

**Objetivo:** Centralizar el *agent-first* para todos los canales (webchat, WhatsApp/IG vía Kommo).  
El Hub orquesta: crea/usa `thread_id` del Assistant, procesa mensajes y escribe en Kommo.

```
Usuario → Chat Web / WhatsApp / IG → Hub (Vercel) → OpenAI Assistant
                                       ↘ Kommo (notas / updates)
```

## Endpoints

### 1) `POST /api/assistant/send`
Entrada:
```json
{
  "sessionId": "web-usuario-123",
  "text": "Quiero un viaje a Estambul",
  "leadId": 98765,             // opcional (Kommo)
  "channel": "web|instagram|whatsapp" // opcional
}
```
Salida:
```json
{
  "ok": true,
  "thread_id": "thread_...",
  "run_status": "completed",
  "text": "Respuesta del Assistant",
  "leadId": 98765
}
```
- Si envías `leadId`, el Hub usará **esa** identidad de sesión: `kommo:lead:{leadId}`.
- Si no hay `leadId`, usa `web:{sessionId}`.
- Si hay `leadId` publica también una **nota** con la respuesta en esa oportunidad.

### 2) `GET /api/assistant/stream?sessionId=...&text=...&leadId=...`
- SSE (Server-Sent Events). Para simplicidad, entrega el mensaje **al completar** el run (no token a token).
- Útil si quieres mantener una sola ruta para UI con “streaming-like”.

### 3) `POST /api/kommo/webhook`
- Configura **Kommo → Webhooks** con evento `message_added` (o el que uses) hacia este endpoint.
- Body esperado mínimo: `{ "text": "...", "lead_id": 12345 }`.
- Flujo: manda al Assistant con sessionId `kommo:lead:{lead_id}` y agrega una **nota** con la respuesta.

### 4) `GET /api/health`
- Healthcheck.

---

## Variables de entorno
Copia `.env.example` y pega en Vercel → *Settings → Environment Variables*

```
OPENAI_API_KEY=sk-xxxx
OPENAI_ASSISTANT_ID=asst_xxxx
KOMMO_BASE_URL=https://TU_SUBDOMINIO.kommo.com
KOMMO_ACCESS_TOKEN=xxxxx
WEBHOOK_SECRET=opcional-token-webhook
# Opcional (persistencia)
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

> Si no configuras Upstash, el ThreadStore será **en memoria** (sirve para pruebas, pero no persiste entre lambdas). Para producción, usa Upstash (o tu DB).

---

## Despliegue (recomendado proyecto **aparte** de tu web)
1. **Nuevo proyecto** en Vercel → sube este repo.
2. Agrega las **ENV** anteriores.
3. Deploy.

**URLs clave:**
- Webhook Kommo: `https://TU-PROYECTO.vercel.app/api/kommo/webhook`
- En tu Chat Web: `POST https://TU-PROYECTO.vercel.app/api/assistant/send`

---

## Conectar tu Chat Web (www.cocovolare.com)

### Ejemplo fetch (no streaming)
```ts
async function sendMessage(text: string) {
  const sessionId = getOrCreateSessionId(); // cookie/localStorage
  const res = await fetch("https://TU-PROYECTO.vercel.app/api/assistant/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, text, channel: "web" })
  });
  const data = await res.json();
  return data.text;
}
```

### Ejemplo SSE (cuando quieras "stream")
```ts
function streamMessage(text) {
  const sessionId = getOrCreateSessionId();
  const url = new URL("https://TU-PROYECTO.vercel.app/api/assistant/stream");
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("text", text);
  const es = new EventSource(url.toString());
  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.done) es.close();
    else renderAssistantText(data.text); // entrega el texto completo al terminar
  };
}
```

---

## Kommo (WhatsApp / Instagram)
1. **Webhook** a `/api/kommo/webhook` con `message_added`.
2. El Hub formará sessionId como `kommo:lead:{lead_id}` y enviará la respuesta del Assistant como **nota**.
3. Si quieres que la respuesta salga **al canal** (no solo nota): agrega en tu automatización de Kommo un Paso que reenvíe la nota como mensaje saliente, o cambia `postNoteToLead` por el endpoint de mensajes salientes del canal (depende de la integración de Kommo).

---

## Roadmap de features (opcionales)
- Persistir `thread_id` en Kommo como campo personalizado (ej. `cf_thread_id`).
- Implementar **tool-calls** en el Hub cuando tu Assistant los pida (requires_action).
- Upsert de lead/contact en Kommo desde `/api/assistant/send` cuando no haya `leadId` (por email/phone).
