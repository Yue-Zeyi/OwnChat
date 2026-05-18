// OwnChat Service Worker — sole proxy for chat stream and image generation
importScripts('chat-stream.js');

const STREAM_KEY = 'active_stream';
const IMAGE_KEY = 'active_image';
const STREAM_DB_NAME = 'ownchat_stream_db';
const STREAM_DB_VERSION = 2;
const STREAM_STORE = 'sessions';

let activeStreamAbort = null;
let activeImageAbort = null;
let activeImageStopStatus = 'stopped';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

function keepAlive(event, promise) {
  if (typeof event.waitUntil === 'function') {
    event.waitUntil(promise);
  }
}

async function notifyClients(message) {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(client => client.postMessage(message));
  } catch { /* ignore */ }
}

async function updateImageSession(session) {
  await updateStreamData(session);
  await notifyClients({ type: 'image-session', session });
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
    if (activeImageAbort) {
      activeImageStopStatus = event.data?.status === 'timeout' ? 'timeout' : 'stopped';
      activeImageAbort.abort();
      activeImageAbort = null;
    }
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
    let requestBody = body;
    let resp = await fetch(url, {
      method: 'POST', headers, body: requestBody, signal: controller.signal,
    });

    if (!resp.ok) {
      let errText = await resp.text().catch(() => '');
      if (errText && /stream_options|include_usage/i.test(errText)) {
        try {
          const fallbackBody = JSON.parse(body || '{}');
          delete fallbackBody.stream_options;
          requestBody = JSON.stringify(fallbackBody);
          resp = await fetch(url, {
            method: 'POST',
            headers,
            body: requestBody,
            signal: controller.signal,
          });
          if (resp.ok) {
            await updateStreamData({ streamOptions: null, usageUnavailable: true, updatedAt: Date.now() });
          } else {
            errText = await resp.text().catch(() => errText);
          }
        } catch {
          await updateStreamData({ status: 'error', updatedAt: Date.now(), error: OwnChatStream.httpErrorText(resp.status, errText) });
          activeStreamAbort = null;
          return;
        }
      }
      if (!resp.ok) {
        await updateStreamData({ status: 'error', updatedAt: Date.now(), error: OwnChatStream.httpErrorText(resp.status, errText) });
        activeStreamAbort = null;
        return;
      }
    }

    await updateStreamData({ status: 'streaming', updatedAt: Date.now() });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamState = OwnChatStream.createStreamState();
    let lastPersist = 0;

    const processStreamLine = (line) => {
      try {
        const json = OwnChatStream.parseSseLine(line);
        if (!json) return;
        const parsed = OwnChatStream.parseChatStreamEvent(json);
        streamState = OwnChatStream.applyStreamDelta(streamState, parsed);
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
          await updateStreamData({
            assistantContent: streamState.content,
            reasoningContent: streamState.reasoning,
            usage: streamState.usage,
            outputStartAt: streamState.outputStartAt,
            status: 'streaming',
            updatedAt: now,
          });
        }
      }

      const completedAt = Date.now();
      await updateStreamData(OwnChatStream.finalizeChatStream(streamState, 'complete', completedAt));
    } catch (e) {
      if (e?.name === 'AbortError') {
        const stoppedAt = Date.now();
        await updateStreamData(OwnChatStream.finalizeChatStream(streamState, 'stopped', stoppedAt));
        activeStreamAbort = null;
        return;
      }
      const erroredAt = Date.now();
      await updateStreamData(OwnChatStream.finalizeChatStream(streamState, 'error', erroredAt, { error: String(e.message || e) }));
    }
  } catch (e) {
    if (e?.name === 'AbortError') {
      await updateStreamData({ status: 'stopped', updatedAt: Date.now() });
      activeStreamAbort = null;
      return;
    }
    await updateStreamData({ status: 'error', updatedAt: Date.now(), error: OwnChatStream.fetchErrorText(e) });
  }
  activeStreamAbort = null;
}

// ===== Image Generation Proxy =====
async function startImage(data) {
  const { jobId, requestType } = data;
  const controller = new AbortController();
  activeImageAbort = controller;
  activeImageStopStatus = 'stopped';
  const startedAt = Number(data.startedAt) || Date.now();
  const timeoutMs = Math.max(60 * 1000, Number(data.timeoutMs) || 30 * 60 * 1000);
  let requestTimedOut = false;
  const timeout = setTimeout(() => {
    requestTimedOut = true;
    controller.abort();
  }, timeoutMs);

  await updateStreamData({
    id: IMAGE_KEY, jobId, requestType,
    status: 'connecting', startedAt, timeoutMs, updatedAt: Date.now(), outputs: '', error: '',
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
        body: sanitizeImageRequestBody(data.body),
        signal: controller.signal,
      });
    } else if (requestType === 'responses') {
      resp = await fetch(data.url, {
        method: 'POST',
        headers: data.headers,
        body: sanitizeImageRequestBody(data.body),
        signal: controller.signal,
      });
    } else if (requestType === 'edit') {
      const form = new FormData();
      const params = data.formParams;
      form.append('model', params.model);
      form.append('prompt', params.prompt);
      const images = Array.isArray(params.images) && params.images.length
        ? params.images
        : (params.imageBase64 ? [{ base64: params.imageBase64, filename: params.imageFilename }] : []);
      images.forEach(item => {
        const imageBlob = dataUrlToBlob(item.base64);
        form.append('image', imageBlob, item.filename || 'reference.png');
      });
      if (params.size && params.size !== 'auto') form.append('size', params.size);
      if (params.quality && params.quality !== 'auto') form.append('quality', params.quality);
      if (params.outputFormat && !/^dall-e/i.test(params.model)) form.append('output_format', params.outputFormat);
      if (
        params.background &&
        params.background !== 'auto' &&
        !(params.background === 'transparent' && /(?:^|[/:])gpt-image-2(?:$|[-_.])/i.test(params.model || ''))
      ) {
        form.append('background', params.background);
      }

      resp = await fetch(data.url, {
        method: 'POST',
        headers: { 'Authorization': data.headers['Authorization'] },
        body: form,
        signal: controller.signal,
      });
    }

    if (!resp) {
      await updateImageSession({
        id: IMAGE_KEY, jobId, requestType, startedAt, timeoutMs,
        status: 'error', updatedAt: Date.now(), error: 'No response received',
      });
      activeImageAbort = null;
      return;
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      await updateImageSession({
        id: IMAGE_KEY, jobId, requestType, startedAt, timeoutMs,
        status: 'error', updatedAt: Date.now(), error: OwnChatStream.httpErrorText(resp.status, errText),
      });
      activeImageAbort = null;
      return;
    }

    const result = await resp.json();

    // Parse outputs based on request type
    let outputs;
    const pushImageOutput = value => {
      if (!value || typeof value !== 'object') return;
      const b64 = value.b64_json || value.b64 || value.image_base64 || value.result || '';
      const url = value.url || value.image_url || '';
      if (!b64 && !url) return;
      outputs.push({
        b64,
        url,
        revisedPrompt: value.revised_prompt || value.revisedPrompt || '',
        format: normalizeImageFormat(value.output_format || value.mime_type || data.outputFormat || 'png'),
        bytes: b64 ? Math.ceil(b64.length * 3 / 4) : 0,
        createdAt: Date.now(),
      });
    };
    if (requestType === 'generations' || requestType === 'edit') {
      outputs = [];
      (result.data || []).forEach(pushImageOutput);
    } else if (requestType === 'responses') {
      outputs = [];
      const scan = value => {
        if (!value) return;
        if (Array.isArray(value)) { value.forEach(scan); return; }
        if (typeof value !== 'object') return;
        pushImageOutput(value);
        Object.keys(value).forEach(k => scan(value[k]));
      };
      scan(result.output || result);
    }

    await updateImageSession({
      id: IMAGE_KEY, jobId, requestType, startedAt, timeoutMs,
      status: 'complete', updatedAt: Date.now(),
      outputs: JSON.stringify(outputs || []),
      usage: normalizeImageUsage(result.usage || result.response?.usage),
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      const status = requestTimedOut || activeImageStopStatus === 'timeout' ? 'timeout' : 'stopped';
      await updateImageSession({
        id: IMAGE_KEY, jobId, requestType, startedAt, timeoutMs,
        status,
        updatedAt: Date.now(),
        error: status === 'timeout' ? '生成超时' : '',
      });
      activeImageAbort = null;
      return;
    }
    await updateImageSession({
      id: IMAGE_KEY, jobId, requestType, startedAt, timeoutMs,
      status: 'error', updatedAt: Date.now(), error: String(e.message || e),
    });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    if (activeImageAbort === controller) activeImageAbort = null;
    activeImageStopStatus = 'stopped';
  }
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

function imageModelDisallowsTransparentBackground(model) {
  return /(?:^|[/:])gpt-image-2(?:$|[-_.])/i.test(model || '');
}

function sanitizeImageRequestBody(body) {
  try {
    const parsed = JSON.parse(body || '{}');
    sanitizeImageRequestValue(parsed);
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function sanitizeImageRequestValue(value, inheritedModel = '') {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach(item => sanitizeImageRequestValue(item, inheritedModel));
    return;
  }
  if (typeof value !== 'object') return;

  const model = typeof value.model === 'string' ? value.model : inheritedModel;
  if (value.background === 'transparent' && imageModelDisallowsTransparentBackground(model)) {
    delete value.background;
  }
  if (value.background === 'transparent' && normalizeImageFormat(value.output_format || value.outputFormat) === 'jpeg') {
    if (value.output_format) value.output_format = 'png';
    if (value.outputFormat) value.outputFormat = 'png';
  }
  Object.keys(value).forEach(key => sanitizeImageRequestValue(value[key], model));
}

function normalizeImageUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.input);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.output);
  const total = Number(usage.total_tokens ?? usage.total);
  const imageInput = Number(usage.input_tokens_details?.image_tokens ?? usage.input_image_tokens);
  const textInput = Number(usage.input_tokens_details?.text_tokens ?? usage.input_text_tokens);
  const imageOutput = Number(usage.output_tokens_details?.image_tokens ?? usage.output_image_tokens);
  const textOutput = Number(usage.output_tokens_details?.text_tokens ?? usage.output_text_tokens);
  const normalized = {};
  if (Number.isFinite(input)) normalized.input = input;
  if (Number.isFinite(output)) normalized.output = output;
  if (Number.isFinite(total)) normalized.total = total;
  const details = {};
  if (Number.isFinite(imageInput)) details.inputImage = imageInput;
  if (Number.isFinite(textInput)) details.inputText = textInput;
  if (Number.isFinite(imageOutput)) details.outputImage = imageOutput;
  if (Number.isFinite(textOutput)) details.outputText = textOutput;
  if (Object.keys(details).length) normalized.details = details;
  return Object.keys(normalized).length ? normalized : null;
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
