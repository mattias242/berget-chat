const $ = (id) => document.getElementById(id);

const state = {
  models: [],
  modelsById: new Map(),
  chat: [],
  recorder: null,
  recordedBlob: null,
  recordingChunks: [],
  recordingStart: 0,
  recordingTimer: null,
};

// --- Tabs ---
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
  });
});

// --- Status / config ---
async function loadConfig() {
  const status = $('status');
  try {
    const r = await fetch('/api/config');
    const cfg = await r.json();
    if (cfg.hasKey) {
      status.textContent = `connected · ${cfg.apiBase}`;
      status.classList.add('ok');
    } else {
      status.textContent = 'BERGET_API_KEY saknas';
      status.classList.add('bad');
    }
  } catch {
    status.textContent = 'kunde inte nå servern';
    status.classList.add('bad');
  }
}

// --- Models ---
function classifyModel(model) {
  const id = (model.id || '').toLowerCase();
  const owner = (model.owned_by || '').toLowerCase();
  const types = new Set();
  if (/whisper|stt|kb-whisper|asr|transcrib/.test(id)) types.add('stt');
  if (/embed|e5|bge(?!.*rerank)/.test(id)) types.add('embedding');
  if (/rerank/.test(id)) types.add('rerank');
  if (/tts|speech|voice/.test(id) && !/whisper/.test(id)) types.add('tts');
  if (/moderation/.test(id)) types.add('moderation');
  if (types.size === 0) types.add('chat');
  return { types, id: model.id, owned_by: owner };
}

function renderModelSelects() {
  const chatSel = $('chat-model');
  const sttSel = $('stt-model');
  const embSel = $('emb-model');
  for (const sel of [chatSel, sttSel, embSel]) sel.innerHTML = '';

  const chatModels = [];
  const sttModels = [];
  const embModels = [];
  for (const m of state.models) {
    const info = classifyModel(m);
    if (info.types.has('chat')) chatModels.push(m);
    if (info.types.has('stt')) sttModels.push(m);
    if (info.types.has('embedding')) embModels.push(m);
  }

  function fill(select, list, fallbackLabel) {
    if (list.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = `(inga ${fallbackLabel} hittade)`;
      select.appendChild(opt);
      return;
    }
    for (const m of list) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id;
      select.appendChild(opt);
    }
  }

  fill(chatSel, chatModels, 'chat-modeller');
  fill(sttSel, sttModels, 'stt-modeller');
  fill(embSel, embModels, 'embedding-modeller');
}

function renderModelsList(filter = '') {
  const out = $('models-output');
  out.innerHTML = '';
  const f = filter.trim().toLowerCase();
  const filtered = state.models.filter((m) => !f || m.id.toLowerCase().includes(f));
  if (filtered.length === 0) {
    out.textContent = 'Inga modeller matchar.';
    return;
  }
  for (const m of filtered) {
    const info = classifyModel(m);
    const card = document.createElement('div');
    card.className = 'model-card';
    const types = [...info.types].join(', ');
    card.innerHTML = `
      <div class="id"></div>
      <div class="meta">typ: ${types}${m.owned_by ? ` · owned_by: ${m.owned_by}` : ''}</div>
    `;
    card.querySelector('.id').textContent = m.id;
    out.appendChild(card);
  }
}

async function loadModels() {
  const out = $('models-output');
  out.textContent = 'Hämtar modeller…';
  try {
    const r = await fetch('/api/models');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    const list = Array.isArray(data) ? data : data.data || [];
    state.models = list;
    state.modelsById = new Map(list.map((m) => [m.id, m]));
    renderModelSelects();
    renderModelsList($('models-filter').value);
  } catch (err) {
    out.textContent = `Kunde inte hämta modeller: ${err.message}`;
  }
}

$('models-refresh').addEventListener('click', loadModels);
$('models-filter').addEventListener('input', (e) => renderModelsList(e.target.value));

// --- Chat ---
function appendMessage(role, content) {
  const log = $('chat-log');
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  const roleEl = document.createElement('div');
  roleEl.className = 'role';
  roleEl.textContent = role;
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = content;
  el.appendChild(roleEl);
  el.appendChild(body);
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return body;
}

function buildMessages() {
  const sys = $('chat-system').value.trim();
  const msgs = [];
  if (sys) msgs.push({ role: 'system', content: sys });
  msgs.push(...state.chat);
  return msgs;
}

async function sendChat(text) {
  state.chat.push({ role: 'user', content: text });
  appendMessage('user', text);
  const assistantBody = appendMessage('assistant', '');
  const meta = $('chat-meta');
  meta.textContent = '…';

  const model = $('chat-model').value;
  if (!model) {
    assistantBody.textContent = 'Ingen modell vald.';
    meta.textContent = '';
    return;
  }

  const stream = $('chat-stream').checked;
  const body = {
    model,
    messages: buildMessages(),
    temperature: parseFloat($('chat-temp').value),
    max_tokens: parseInt($('chat-maxtokens').value, 10),
    stream,
  };

  const t0 = performance.now();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      assistantBody.textContent = `Fel: ${res.status} ${errText}`;
      meta.textContent = '';
      return;
    }

    let acc = '';

    if (!stream) {
      const data = await res.json();
      acc = data?.choices?.[0]?.message?.content || '';
      assistantBody.textContent = acc;
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of event.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const json = JSON.parse(payload);
              const delta = json?.choices?.[0]?.delta?.content || json?.choices?.[0]?.message?.content || '';
              if (delta) {
                acc += delta;
                assistantBody.textContent = acc;
                $('chat-log').scrollTop = $('chat-log').scrollHeight;
              }
            } catch {}
          }
        }
      }
    }

    state.chat.push({ role: 'assistant', content: acc });
    const ms = Math.round(performance.now() - t0);
    meta.textContent = `${model} · ${ms} ms`;
  } catch (err) {
    assistantBody.textContent = `Fel: ${err.message}`;
    meta.textContent = '';
  }
}

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chat-text').value.trim();
  if (!text) return;
  $('chat-text').value = '';
  sendChat(text);
});

$('chat-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    $('chat-form').requestSubmit();
  }
});

$('chat-clear').addEventListener('click', () => {
  state.chat = [];
  $('chat-log').innerHTML = '';
  $('chat-meta').textContent = '';
});

// --- STT ---
const dropzone = $('dropzone');
const fileInput = $('stt-file');

function setSttFile(file) {
  state.recordedBlob = file || null;
  $('stt-filename').textContent = file ? `${file.name || 'inspelning'} · ${(file.size / 1024).toFixed(1)} kB` : 'Inga filer valda';
  $('stt-run').disabled = !file;
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  const file = e.dataTransfer.files?.[0];
  if (file) setSttFile(file);
});
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) setSttFile(file);
});

$('rec-start').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Webbläsaren saknar stöd för mikrofon.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    state.recordingChunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) state.recordingChunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(state.recordingChunks, { type: recorder.mimeType || 'audio/webm' });
      const ext = (recorder.mimeType || 'audio/webm').includes('mp4') ? 'mp4' : 'webm';
      const file = new File([blob], `recording.${ext}`, { type: blob.type });
      setSttFile(file);
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(state.recordingTimer);
      $('rec-meta').textContent = `inspelad · ${(file.size / 1024).toFixed(1)} kB`;
    };
    recorder.start();
    state.recorder = recorder;
    state.recordingStart = Date.now();
    $('rec-start').disabled = true;
    $('rec-stop').disabled = false;
    state.recordingTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - state.recordingStart) / 1000);
      $('rec-meta').textContent = `spelar in… ${sec}s`;
    }, 250);
  } catch (err) {
    alert(`Kunde inte starta inspelning: ${err.message}`);
  }
});

$('rec-stop').addEventListener('click', () => {
  state.recorder?.stop();
  state.recorder = null;
  $('rec-start').disabled = false;
  $('rec-stop').disabled = true;
});

$('stt-run').addEventListener('click', async () => {
  const file = state.recordedBlob;
  if (!file) return;
  const model = $('stt-model').value;
  if (!model) { alert('Välj en STT-modell.'); return; }

  const fd = new FormData();
  fd.append('file', file, file.name || 'audio');
  fd.append('model', model);
  if ($('stt-language').value) fd.append('language', $('stt-language').value);
  if ($('stt-prompt').value) fd.append('prompt', $('stt-prompt').value);
  fd.append('response_format', $('stt-format').value);
  fd.append('temperature', $('stt-temp').value);

  const out = $('stt-output');
  const meta = $('stt-meta');
  out.textContent = 'Transkriberar…';
  meta.textContent = '';
  const t0 = performance.now();
  try {
    const res = await fetch('/api/transcribe', { method: 'POST', body: fd });
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!res.ok) {
      out.textContent = `Fel: ${res.status}\n${text}`;
      return;
    }
    if (ct.includes('application/json')) {
      try {
        const json = JSON.parse(text);
        out.textContent = JSON.stringify(json, null, 2);
      } catch { out.textContent = text; }
    } else {
      out.textContent = text;
    }
    meta.textContent = `${model} · ${Math.round(performance.now() - t0)} ms`;
  } catch (err) {
    out.textContent = `Fel: ${err.message}`;
  }
});

// --- Embeddings ---
$('emb-run').addEventListener('click', async () => {
  const model = $('emb-model').value;
  if (!model) { alert('Välj en embedding-modell.'); return; }
  const input = $('emb-input').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (input.length === 0) { alert('Skriv minst en rad.'); return; }
  const out = $('emb-output');
  const meta = $('emb-meta');
  out.textContent = 'Genererar…';
  meta.textContent = '';
  const t0 = performance.now();
  try {
    const res = await fetch('/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
    });
    const text = await res.text();
    if (!res.ok) { out.textContent = `Fel: ${res.status}\n${text}`; return; }
    try {
      const json = JSON.parse(text);
      const summary = (json.data || []).map((d, i) => ({
        index: i,
        dim: Array.isArray(d.embedding) ? d.embedding.length : null,
        preview: Array.isArray(d.embedding) ? d.embedding.slice(0, 6).map((n) => n.toFixed(4)) : null,
      }));
      out.textContent = JSON.stringify({ model: json.model, usage: json.usage, vectors: summary }, null, 2);
    } catch {
      out.textContent = text;
    }
    meta.textContent = `${model} · ${Math.round(performance.now() - t0)} ms`;
  } catch (err) {
    out.textContent = `Fel: ${err.message}`;
  }
});

// --- Init ---
loadConfig().then(loadModels);
