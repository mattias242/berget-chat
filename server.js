import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

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

app.get('/api/usage', async (_req, res) => {
  if (!requireKey(res)) return;
  const host = API_BASE.replace(/\/v1\/?$/, '');
  const candidates = [
    '/v1/me',
    '/v1/credits',
    '/v1/account',
    '/v1/usage',
    '/v1/billing/credit_grants',
    '/v1/dashboard/billing/credit_grants',
    '/v1/organization',
    '/v1/balance',
  ];
  const tried = [];
  for (const path of candidates) {
    try {
      const r = await fetch(`${host}${path}`, { headers: authHeaders() });
      tried.push({ path, status: r.status });
      if (r.ok) {
        const ct = r.headers.get('content-type') || '';
        const data = ct.includes('application/json') ? await r.json() : await r.text();
        res.json({ path, data });
        return;
      }
    } catch (err) {
      tried.push({ path, error: String(err) });
    }
  }
  res.status(404).json({ error: 'Hittade ingen credits/usage-endpoint.', tried });
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

// --- Knowledge base (in-memory) -------------------------------------------

const kb = {
  systemPrompt: '',
  systemPromptName: '',
  embeddingModel: '',
  documents: [], // [{ name, pages, chunks: [{ text, embedding }] }]
};

function chunkText(raw, target = 1000, overlap = 200) {
  const text = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return [];
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + target, text.length);
    if (end < text.length) {
      const slice = text.slice(i, end);
      const para = slice.lastIndexOf('\n\n');
      const sent = slice.lastIndexOf('. ');
      if (para > target * 0.5) end = i + para + 2;
      else if (sent > target * 0.5) end = i + sent + 2;
    }
    const piece = text.slice(i, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return chunks;
}

async function embedTexts(texts, model) {
  const out = [];
  const batchSize = 32;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const r = await fetch(`${API_BASE}/embeddings`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model, input: batch }),
    });
    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Embedding ${r.status}: ${err}`);
    }
    const data = await r.json();
    for (const item of data.data) out.push(item.embedding);
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

app.get('/api/kb', (_req, res) => {
  res.json({
    systemPromptName: kb.systemPromptName,
    systemPromptLength: kb.systemPrompt.length,
    systemPromptPreview: kb.systemPrompt.slice(0, 600),
    embeddingModel: kb.embeddingModel,
    documents: kb.documents.map((d) => ({ name: d.name, pages: d.pages, chunks: d.chunks.length })),
  });
});

app.delete('/api/kb', (_req, res) => {
  kb.systemPrompt = '';
  kb.systemPromptName = '';
  kb.embeddingModel = '';
  kb.documents = [];
  res.json({ ok: true });
});

app.post('/api/kb/prompt', upload.single('file'), (req, res) => {
  let text = '';
  let name = 'prompt';
  if (req.file) {
    text = req.file.buffer.toString('utf-8');
    name = req.file.originalname || 'prompt.md';
  } else if (req.body?.text) {
    text = req.body.text;
    name = req.body.name || 'inline';
  }
  if (!text.trim()) {
    res.status(400).json({ error: 'Ingen prompt-text/fil tillhandahållen.' });
    return;
  }
  kb.systemPrompt = text;
  kb.systemPromptName = name;
  res.json({ ok: true, name, length: text.length });
});

app.post('/api/kb/pdf', upload.single('file'), async (req, res) => {
  if (!requireKey(res)) return;
  if (!req.file) { res.status(400).json({ error: 'Ingen fil uppladdad (fält "file").' }); return; }
  const embeddingModel = req.body?.embedding_model;
  if (!embeddingModel) { res.status(400).json({ error: 'Saknar embedding_model.' }); return; }

  try {
    const parsed = await pdfParse(req.file.buffer);
    const text = (parsed.text || '').trim();
    if (!text) {
      res.status(400).json({ error: 'PDF:en innehåller ingen extraherbar text (kanske skannad?).' });
      return;
    }
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      res.status(400).json({ error: 'Kunde inte chunka texten.' });
      return;
    }
    const embeddings = await embedTexts(chunks, embeddingModel);

    if (kb.embeddingModel && kb.embeddingModel !== embeddingModel) {
      kb.documents = [];
    }
    kb.embeddingModel = embeddingModel;
    kb.documents.push({
      name: req.file.originalname || 'document.pdf',
      pages: parsed.numpages,
      chunks: chunks.map((text, i) => ({ text, embedding: embeddings[i] })),
    });

    res.json({ ok: true, name: req.file.originalname, pages: parsed.numpages, chunks: chunks.length });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post('/api/kb/chat', async (req, res) => {
  if (!requireKey(res)) return;
  const body = req.body || {};
  const { messages, model, top_k = 5 } = body;
  if (!model) { res.status(400).json({ error: 'model krävs.' }); return; }
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages krävs.' });
    return;
  }
  const stream = body.stream !== false;

  try {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    let retrieved = [];
    if (lastUser?.content && kb.embeddingModel && kb.documents.length > 0) {
      const [queryEmb] = await embedTexts([lastUser.content], kb.embeddingModel);
      const all = [];
      for (const doc of kb.documents) {
        for (let i = 0; i < doc.chunks.length; i++) {
          all.push({
            source: doc.name,
            chunkIndex: i,
            text: doc.chunks[i].text,
            score: cosine(queryEmb, doc.chunks[i].embedding),
          });
        }
      }
      all.sort((a, b) => b.score - a.score);
      retrieved = all.slice(0, Math.max(1, Math.min(20, top_k)));
    }

    const contextBlock = retrieved.length
      ? '\n\n=== Relevanta utdrag ur dokumenten ===\n' +
        retrieved.map((r, i) => `[${i + 1}] (${r.source}, chunk ${r.chunkIndex})\n${r.text}`).join('\n\n')
      : '';
    const baseSystem = kb.systemPrompt || 'Du är en hjälpsam assistent.';
    const followUp = retrieved.length
      ? '\n\nSvara baserat på utdragen ovan när det är relevant. Om svaret inte finns i utdragen, säg det. Hänvisa till källan med [n].'
      : '';
    const finalMessages = [
      { role: 'system', content: baseSystem + contextBlock + followUp },
      ...messages,
    ];

    const upstream = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model,
        messages: finalMessages,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        stream,
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(errText);
      return;
    }

    const sourcesPayload = retrieved.map((r) => ({
      source: r.source,
      chunk: r.chunkIndex,
      score: Number(r.score.toFixed(4)),
      preview: r.text.slice(0, 280),
    }));

    if (!stream) {
      const data = await upstream.json();
      res.json({ ...data, _sources: sourcesPayload });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ _sources: sourcesPayload })}\n\n`);

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
    if (!res.headersSent) res.status(502).json({ error: String(err?.message || err) });
    else res.end();
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
