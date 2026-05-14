// OwnChat Service Worker — sole proxy for chat stream and image generation
const STREAM_KEY = 'active_stream';
const IMAGE_KEY = 'active_image';
const STREAM_DB_NAME = 'ownchat_stream_db';
const STREAM_DB_VERSION = 2;
const STREAM_STORE = 'sessions';

let activeStreamAbort = null;
let activeImageAbort = null;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

function keepAlive(event, promise) {
  if (typeof event.waitUntil === 'function') {
    event.waitUntil(promise);
  }
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'start-stream') {
    keepAlive(event, startStream(event.data));
  }
  if (event.data?.type === 'stop-stream') {
    if (activeStreamAbort) { activeStreamAbort.abort(); activeStreamAbort = null; }
  }
  if (event.data?.type === 'start-image') {
    keepAlive(event, startImage(event.data));
  }
  if (event.data?.type === 'stop-image') {
    if (activeImageAbort) { activeImageAbort.abort(); activeImageAbort = null; }
  }
});

// ===== Chat Stream Proxy =====
async function startStream(data) {
  const { url, headers, body, convId, model } = data;
  const controller = new AbortController();
  activeStreamAbort = controller;
  let requestMeta = {};
  try {
    const parsedBody = JSON.parse(body || '{}');
    requestMeta = {
      requestInputTokens: data.requestInputTokens,
      includeContext: data.includeContext,
      streamOptions: parsedBody.stream_options || null,
    };
  } catch {
    requestMeta = { requestInputTokens: data.requestInputTokens, includeContext: data.includeContext };
  }

  await updateStreamData({
    id: STREAM_KEY, convId, model,
    assistantContent: '', reasoningContent: '',
    status: 'connecting', updatedAt: Date.now(), error: '',
    usage: null,
    ...requestMeta,
  });

  try {
    let resp = await fetch(url, {
      method: 'POST', headers, body, signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      if (errText && /stream_options|include_usage/i.test(errText)) {
        try {
          const fallbackBody = JSON.parse(body || '{}');
          delete fallbackBody.stream_options;
          resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(fallbackBody),
            signal: controller.signal,
          });
          if (resp.ok) {
            await updateStreamData({ streamOptions: null, usageUnavailable: true, updatedAt: Date.now() });
          } else {
            const retryErrText = await resp.text().catch(() => '');
            await updateStreamData({ status: 'error', updatedAt: Date.now(), error: `HTTP ${resp.status}: ${retryErrText.slice(0, 500)}` });
            activeStreamAbort = null;
            return;
          }
        } catch {
          await updateStreamData({ status: 'error', updatedAt: Date.now(), error: `HTTP ${resp.status}: ${errText.slice(0, 500)}` });
          activeStreamAbort = null;
          return;
        }
      } else {
        await updateStreamData({ status: 'error', updatedAt: Date.now(), error: `HTTP ${resp.status}: ${errText.slice(0, 500)}` });
        activeStreamAbort = null;
        return;
      }
    }

    await updateStreamData({ status: 'streaming', updatedAt: Date.now() });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let assistantContent = '';
    let reasoningContent = '';
    let usage = null;
    let lastPersist = 0;
    let outputStartAt = null;

    const processStreamLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta;
        if (delta?.reasoning_content) reasoningContent += delta.reasoning_content;
        if (delta?.thinking) reasoningContent += delta.thinking;
        if (delta?.content) {
          if (!outputStartAt) outputStartAt = Date.now();
          assistantContent += delta.content;
        }
      } catch { /* skip */ }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) processStreamLine(buffer);
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) processStreamLine(line);

        const now = Date.now();
        if (now - lastPersist > 300) {
          lastPersist = now;
          await updateStreamData({ assistantContent, reasoningContent, usage, outputStartAt, status: 'streaming', updatedAt: now });
        }
      }

      const completedAt = Date.now();
      await updateStreamData({
        assistantContent,
        reasoningContent,
        usage,
        outputStartAt,
        outputEndAt: completedAt,
        outputTimeMs: outputStartAt ? completedAt - outputStartAt : null,
        status: 'complete',
        updatedAt: completedAt,
      });
    } catch (e) {
      if (e?.name === 'AbortError') {
        const stoppedAt = Date.now();
        await updateStreamData({
          assistantContent,
          reasoningContent,
          usage,
          outputStartAt,
          outputEndAt: stoppedAt,
          outputTimeMs: outputStartAt ? stoppedAt - outputStartAt : null,
          status: 'stopped',
          updatedAt: stoppedAt,
        });
        activeStreamAbort = null;
        return;
      }
      const erroredAt = Date.now();
      await updateStreamData({
        assistantContent,
        reasoningContent,
        usage,
        outputStartAt,
        outputEndAt: erroredAt,
        outputTimeMs: outputStartAt ? erroredAt - outputStartAt : null,
        status: 'error',
        updatedAt: erroredAt,
        error: String(e.message || e),
      });
    }
  } catch (e) {
    if (e?.name === 'AbortError') {
      await updateStreamData({ status: 'stopped', updatedAt: Date.now() });
      activeStreamAbort = null;
      return;
    }
    await updateStreamData({ status: 'error', updatedAt: Date.now(), error: `Fetch failed: ${e.message || String(e)}` });
  }
  activeStreamAbort = null;
}

// ===== Image Generation Proxy =====
async function startImage(data) {
  const { jobId, requestType } = data;
  const controller = new AbortController();
  activeImageAbort = controller;

  await updateStreamData({
    id: IMAGE_KEY, jobId, requestType,
    status: 'connecting', updatedAt: Date.now(), outputs: '', error: '',
  });
  const heartbeat = setInterval(() => {
    updateStreamData({ id: IMAGE_KEY, updatedAt: Date.now() });
  }, 15000);

  try {
    let resp;

    if (requestType === 'generations') {
      resp = await fetch(data.url, {
        method: 'POST',
        headers: data.headers,
        body: data.body,
        signal: controller.signal,
      });
      // Fallback: retry without optional params if first request fails
      if (!resp.ok) {
        const bodyObj = JSON.parse(data.body);
        if (bodyObj.output_format || bodyObj.background || bodyObj.quality) {
          const fallback = { model: bodyObj.model, prompt: bodyObj.prompt, n: 1 };
          if (bodyObj.size && bodyObj.size !== 'auto') fallback.size = bodyObj.size;
          resp = await fetch(data.url, {
            method: 'POST',
            headers: data.headers,
            body: JSON.stringify(fallback),
            signal: controller.signal,
          });
        }
      }
    } else if (requestType === 'responses') {
      resp = await fetch(data.url, {
        method: 'POST',
        headers: data.headers,
        body: data.body,
        signal: controller.signal,
      });
      // Fallback retries for Responses API
      if (!resp.ok) {
        const bodyObj = JSON.parse(data.body);
        bodyObj.tool_choice = { type: 'image_generation' };
        resp = await fetch(data.url, {
          method: 'POST', headers: data.headers,
          body: JSON.stringify(bodyObj), signal: controller.signal,
        });
      }
      if (!resp.ok) {
        const bodyObj = JSON.parse(data.body);
        if (bodyObj.tools?.[0]?.output_format || bodyObj.tools?.[0]?.background || bodyObj.tools?.[0]?.quality || bodyObj.tools?.[0]?.size) {
          const fallback = { model: bodyObj.model, input: bodyObj.input, tools: [{ type: 'image_generation' }], tool_choice: 'required' };
          resp = await fetch(data.url, {
            method: 'POST', headers: data.headers,
            body: JSON.stringify(fallback), signal: controller.signal,
          });
        }
      }
    } else if (requestType === 'edit') {
      // Reconstruct FormData from serialized params
      const form = new FormData();
      const params = data.formParams;
      form.append('model', params.model);
      form.append('prompt', params.prompt);
      // Convert base64 back to Blob for the image field
      const imageBlob = dataUrlToBlob(params.imageBase64);
      form.append('image', imageBlob, params.imageFilename);
      if (params.size && params.size !== 'auto') form.append('size', params.size);
      if (params.quality && params.quality !== 'auto') form.append('quality', params.quality);
      if (params.outputFormat && !/^dall-e/i.test(params.model)) form.append('output_format', params.outputFormat);
      if (params.background && params.background !== 'auto') form.append('background', params.background);

      resp = await fetch(data.url, {
        method: 'POST',
        headers: { 'Authorization': data.headers['Authorization'] },
        body: form,
        signal: controller.signal,
      });
      // Fallback for edit: retry with minimal params
      if (!resp.ok && (params.quality !== 'auto' || params.outputFormat || params.background !== 'auto')) {
        const fallback = new FormData();
        fallback.append('model', params.model);
        fallback.append('prompt', params.prompt);
        const refBlob2 = dataUrlToBlob(params.imageBase64);
        fallback.append('image', refBlob2, params.imageFilename);
        if (params.size && params.size !== 'auto') fallback.append('size', params.size);
        resp = await fetch(data.url, {
          method: 'POST',
          headers: { 'Authorization': data.headers['Authorization'] },
          body: fallback,
          signal: controller.signal,
        });
      }
    }

    if (!resp) {
      await updateStreamData({ id: IMAGE_KEY, status: 'error', updatedAt: Date.now(), error: 'No response received' });
      activeImageAbort = null;
      return;
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      await updateStreamData({ id: IMAGE_KEY, status: 'error', updatedAt: Date.now(), error: `HTTP ${resp.status}: ${errText.slice(0, 500)}` });
      activeImageAbort = null;
      return;
    }

    const result = await resp.json();

    // Parse outputs based on request type
    let outputs;
    if (requestType === 'generations' || requestType === 'edit') {
      outputs = (result.data || []).map(item => ({
        b64: item.b64_json || '',
        url: item.url || '',
        revisedPrompt: item.revised_prompt || '',
        format: normalizeImageFormat(item.output_format || item.mime_type || data.outputFormat || 'png'),
        bytes: item.b64_json ? Math.ceil(item.b64_json.length * 3 / 4) : 0,
        createdAt: Date.now(),
      })).filter(item => item.b64 || item.url);
    } else if (requestType === 'responses') {
      outputs = [];
      const scan = value => {
        if (!value) return;
        if (Array.isArray(value)) { value.forEach(scan); return; }
        if (typeof value !== 'object') return;
        if ((value.type === 'image_generation_call' || value.type === 'image_generation') && value.result) {
          outputs.push({
            b64: value.result, url: '', revisedPrompt: '',
            format: normalizeImageFormat(value.output_format || value.mime_type || data.outputFormat || 'png'),
            bytes: Math.ceil(value.result.length * 3 / 4),
            createdAt: Date.now(),
          });
        }
        Object.keys(value).forEach(k => scan(value[k]));
      };
      scan(result.output || result);
    }

    await updateStreamData({
      id: IMAGE_KEY, status: 'complete', updatedAt: Date.now(),
      outputs: JSON.stringify(outputs || []),
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      await updateStreamData({ id: IMAGE_KEY, status: 'stopped', updatedAt: Date.now() });
      activeImageAbort = null;
      return;
    }
    await updateStreamData({ id: IMAGE_KEY, status: 'error', updatedAt: Date.now(), error: String(e.message || e) });
  } finally {
    clearInterval(heartbeat);
  }
  activeImageAbort = null;
}

function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const mime = parts[0].match(/:(.*?);/)[1];
  const b64 = atob(parts[1]);
  const arr = new Uint8Array(b64.length);
  for (let i = 0; i < b64.length; i++) arr[i] = b64.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function normalizeImageFormat(raw) {
  if (!raw) return 'png';
  const lower = raw.toLowerCase();
  if (lower.includes('png')) return 'png';
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpeg';
  if (lower.includes('webp')) return 'webp';
  return lower;
}

// ===== IndexedDB helpers =====
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(STREAM_DB_NAME, STREAM_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STREAM_STORE)) {
        db.createObjectStore(STREAM_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function updateStreamData(data) {
  try {
    const db = await openDb();
    const tx = db.transaction(STREAM_STORE, 'readwrite');
    const store = tx.objectStore(STREAM_STORE);
    const key = data.id || STREAM_KEY;
    const existing = await new Promise(r => {
      const req = store.get(key);
      req.onsuccess = () => r(req.result);
      req.onerror = () => r(null);
    });
    if (existing) {
      store.put(Object.assign({}, existing, data));
    } else {
      store.put(data);
    }
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
  } catch { /* ignore */ }
}
