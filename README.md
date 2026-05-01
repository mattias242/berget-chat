# Berget Model Tester

En enkel Node-webapp för att testa alla modeller på [Berget AI](https://docs.berget.ai/models/overview) — både text/chat-modeller och speech-to-text (Whisper / KB-Whisper). Embeddings stöds också.

Berget AI exponerar ett OpenAI-kompatibelt API på `https://api.berget.ai/v1`. Servern proxar anrop så att din API-nyckel aldrig läcker ut till webbläsaren.

## Funktioner

- **Modeller** — listar `/v1/models` direkt från ditt konto och kategoriserar dem som chat / stt / embedding.
- **Chat** — strömmande chat med valbar systemprompt, temperature och max tokens.
- **Speech-to-text** — drag och släpp en ljudfil, eller spela in från mikrofonen i webbläsaren.
- **Embeddings** — skicka en eller flera rader och få ut vektordimensioner och en preview.

## Kom igång

```bash
cp .env.example .env
# lägg in din BERGET_API_KEY i .env

npm install
npm start
```

Öppna sedan http://localhost:3000.

## Miljövariabler

| Variabel | Default | Beskrivning |
| --- | --- | --- |
| `BERGET_API_KEY` | — | Din API-nyckel från [console.berget.ai](https://console.berget.ai). |
| `BERGET_API_BASE` | `https://api.berget.ai/v1` | Bas-URL för API:t. |
| `PORT` | `3000` | Port för webbservern. |

## API-endpoints (proxy)

| Endpoint | Beskrivning |
| --- | --- |
| `GET /api/config` | Visar om nyckel finns och vilken bas-URL som används. |
| `GET /api/models` | Proxar `/v1/models`. |
| `POST /api/chat` | Proxar `/v1/chat/completions` (stöder SSE-stream). |
| `POST /api/transcribe` | Proxar `/v1/audio/transcriptions` (multipart). |
| `POST /api/embeddings` | Proxar `/v1/embeddings`. |

## Krav

- Node.js 18.18 eller senare (för inbyggd `fetch` och `FormData`).
