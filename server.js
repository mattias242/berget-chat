import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const API_BASE = (process.env.BERGET_API_BASE || 'https://api.berget.ai/v1').replace(/\/$/, '');
const API_KEY = process.env.BERGET_API_KEY;

if (!API_KEY) {
  console.warn('[warn] BERGET_API_KEY is not set. Copy .env.example to .env and add your key.');
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${API_KEY}`,
    ...extra,
  };
}

function requireKey(res) {
  if (!API_KEY) {
    res.status(500).json({ error: 'BERGET_API_KEY is not configured on the server.' });
    return false;
  }
  return true;
}

app.get('/api/config', (_req, res) => {
  res.json({ apiBase: API_BASE, hasKey: Boolean(API_KEY) });
});

app.get('/api/models', async (_req, res) => {
  if (!requireKey(res)) return;
  try {
    const r = await fetch(`${API_BASE}/models`, { headers: authHeaders() });
    const text = await r.text();
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
  } catch (err) {
    res.status(502).json({ error: 'Upstream request failed', details: String(err) });
  }
});

app.post('/api/chat', async (req, res) => {
  if (!requireKey(res)) return;

  const body = req.body || {};
  const stream = body.stream !== false;
  const upstreamBody = { ...body, stream };

  try {
    const upstream = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(upstreamBody),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(errText);
      return;
    }

    if (!stream) {
      const json = await upstream.text();
      res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(json);
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let aborted = false;
    req.on('close', () => { aborted = true; reader.cancel().catch(() => {}); });

    while (!aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Upstream request failed', details: String(err) });
    } else {
      res.end();
    }
  }
});

app.post('/api/transcribe', upload.single('file'), async (req, res) => {
  if (!requireKey(res)) return;
  if (!req.file) {
    res.status(400).json({ error: 'No audio file uploaded under field "file".' });
    return;
  }

  try {
    const form = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' });
    form.append('file', blob, req.file.originalname || 'audio');

    if (req.body.model) form.append('model', req.body.model);
    if (req.body.language) form.append('language', req.body.language);
    if (req.body.prompt) form.append('prompt', req.body.prompt);
    if (req.body.response_format) form.append('response_format', req.body.response_format);
    if (req.body.temperature) form.append('temperature', req.body.temperature);

    const upstream = await fetch(`${API_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });

    const text = await upstream.text();
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
  } catch (err) {
    res.status(502).json({ error: 'Upstream request failed', details: String(err) });
  }
});

app.post('/api/embeddings', async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const upstream = await fetch(`${API_BASE}/embeddings`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(req.body || {}),
    });
    const text = await upstream.text();
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
  } catch (err) {
    res.status(502).json({ error: 'Upstream request failed', details: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Berget model tester running at http://localhost:${PORT}`);
  console.log(`Proxying to ${API_BASE}`);
});
