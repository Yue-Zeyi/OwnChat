// ===== Embedded shared protocol helpers =====
(function () {
  'use strict';

  function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.input);
    const output = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.output);
    const total = Number(usage.total_tokens ?? usage.total);
    const normalized = {};
    if (Number.isFinite(input)) normalized.input = input;
    if (Number.isFinite(output)) normalized.output = output;
    if (Number.isFinite(total)) normalized.total = total;
    return Object.keys(normalized).length ? normalized : null;
  }

  function parseChatStreamEvent(json) {
    const usage = normalizeUsage(json?.usage || json?.response?.usage);
    const delta = json?.choices?.[0]?.delta || {};
    return {
      usage,
      reasoning: delta.reasoning_content || delta.thinking || json?.delta_reasoning || json?.reasoning_delta || '',
      content: delta.content || json?.delta || (json?.type === 'response.output_text.delta' ? json.delta : '') || '',
    };
  }

  function parseSseLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed || !trimmed.startsWith('data:')) return null;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return null;
    return JSON.parse(payload);
  }

  function createStreamState(seed = {}) {
    return Object.assign({
      content: '',
      reasoning: '',
      usage: null,
      outputStartAt: null,
    }, seed);
  }

  function applyStreamDelta(state, event, now = Date.now()) {
    const next = createStreamState(state);
    if (event?.usage) next.usage = event.usage;
    if (event?.reasoning) next.reasoning += event.reasoning;
    if (event?.content) {
      if (!next.outputStartAt) next.outputStartAt = now;
      next.content += event.content;
    }
    return next;
  }

  function finalizeChatStream(state, status = 'complete', now = Date.now(), extra = {}) {
    const outputTimeMs = state?.outputStartAt ? now - state.outputStartAt : null;
    return Object.assign({
      assistantContent: state?.content || '',
      reasoningContent: state?.reasoning || '',
      usage: state?.usage || null,
      outputStartAt: state?.outputStartAt || null,
      outputEndAt: now,
      outputTimeMs,
      status,
      updatedAt: now,
    }, extra);
  }

  function removeStreamOptions(body) {
    const copy = Object.assign({}, body);
    delete copy.stream_options;
    return copy;
  }

  function httpErrorText(status, text = '') {
    const detail = String(text || '').slice(0, 500);
    return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
  }

  function fetchErrorText(error) {
    return `Fetch failed: ${error?.message || String(error)}`;
  }

  const api = {
    normalizeUsage,
    parseChatStreamEvent,
    parseSseLine,
    createStreamState,
    applyStreamDelta,
    finalizeChatStream,
    removeStreamOptions,
    httpErrorText,
    fetchErrorText,
  };

  if (typeof self !== 'undefined') self.OwnChatStream = api;
  if (typeof window !== 'undefined') window.OwnChatStream = api;
})();

(function () {
  'use strict';

  function normalizeImageFormat(format) {
    const value = (format || '').toLowerCase().replace(/^image\//, '');
    if (value === 'jpg') return 'jpeg';
    if (value.includes('jpeg')) return 'jpeg';
    if (value.includes('png')) return 'png';
    if (value.includes('webp')) return 'webp';
    return value || '';
  }

  function normalizeImageModel(model) {
    return (model || '').trim().toLowerCase();
  }

  function imageModelDisallowsTransparentBackground(model) {
    return /(?:^|[/:])gpt-image-2(?:$|[-_.])/.test(normalizeImageModel(model));
  }

  function imageBackgroundSupported(model, background) {
    return background !== 'transparent' || !imageModelDisallowsTransparentBackground(model);
  }

  function sanitizeImageParamsForModel(model, params = {}) {
    const next = Object.assign({}, params);
    if (!imageBackgroundSupported(model, next.background)) next.background = 'auto';
    if (next.background === 'transparent' && normalizeImageFormat(next.outputFormat) === 'jpeg') {
      next.outputFormat = 'png';
    }
    return next;
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

  function sanitizeImageRequestBody(body) {
    try {
      const parsed = JSON.parse(body || '{}');
      sanitizeImageRequestValue(parsed);
      return JSON.stringify(parsed);
    } catch {
      return body;
    }
  }

  function normalizeImageUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.input);
    const output = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.output);
    const total = Number(usage.total_tokens ?? usage.total);
    const imageInput = Number(usage.input_tokens_details?.image_tokens ?? usage.input_image_tokens ?? usage.details?.inputImage);
    const textInput = Number(usage.input_tokens_details?.text_tokens ?? usage.input_text_tokens ?? usage.details?.inputText);
    const imageOutput = Number(usage.output_tokens_details?.image_tokens ?? usage.output_image_tokens ?? usage.details?.outputImage);
    const textOutput = Number(usage.output_tokens_details?.text_tokens ?? usage.output_text_tokens ?? usage.details?.outputText);
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

  function dataUrlToBlob(dataUrl) {
    const [header, data] = String(dataUrl || '').split(',');
    const mime = header?.match(/data:([^;]+)/)?.[1] || 'image/png';
    const bin = atob(data || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  const api = {
    normalizeImageFormat,
    normalizeImageModel,
    imageModelDisallowsTransparentBackground,
    imageBackgroundSupported,
    sanitizeImageParamsForModel,
    sanitizeImageRequestValue,
    sanitizeImageRequestBody,
    normalizeImageUsage,
    dataUrlToBlob,
  };

  if (typeof self !== 'undefined') self.OwnChatImageShared = api;
  if (typeof window !== 'undefined') window.OwnChatImageShared = api;
})();

(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis);
  const DEFAULT_CONTEXT_LIMIT = 256000;
  const TOKEN_K = 1000;

  function attachments() {
    return root.OwnChatAttachments;
  }

  function estimateTokens(text) {
    if (!text) return 0;
    let tokens = 0;
    for (const char of text) {
      const code = char.charCodeAt(0);
      if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) {
        tokens += 1.5;
      } else if (code > 127) {
        tokens += 1.2;
      } else {
        tokens += 0.25;
      }
    }
    return Math.ceil(tokens);
  }

  function tokensToK(tokens, fallback) {
    if (tokens === null || tokens === undefined || tokens === '') return '';
    const value = Number.isFinite(Number(tokens)) ? Number(tokens) : fallback;
    return Math.round(value / TOKEN_K);
  }

  function kToTokens(value, fallback, opts = {}) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const kValue = parseFloat(value);
    if (!Number.isFinite(kValue) || kValue < 0) return fallback;
    if (opts.allowZero && kValue === 0) return 0;
    return Math.max(TOKEN_K, Math.round(kValue * TOKEN_K));
  }

  function explicitMaxTokens(conv) {
    const value = Number(conv?.maxTokens);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.round(value);
  }

  function trimContextMessages(messages, systemPrompt, maxTokens) {
    if (maxTokens === 0) {
      const allMessages = [];
      if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt });
      allMessages.push(...messages);
      return allMessages;
    }
    maxTokens = maxTokens || DEFAULT_CONTEXT_LIMIT;
    const allMessages = [];
    if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt });
    allMessages.push(...messages);

    let totalTokens = 0;
    for (const message of allMessages) totalTokens += estimateMessageTokens(message);

    if (totalTokens <= maxTokens) return allMessages;

    const sysMsg = allMessages[0]?.role === 'system' ? allMessages[0] : null;
    const rest = sysMsg ? allMessages.slice(1) : allMessages;

    let lastUserIdx = -1;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (rest[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    const keepTail = rest.slice(Math.max(0, lastUserIdx));
    const tailTokens = keepTail.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    const sysTokens = sysMsg ? estimateTokens(sysMsg.content) : 0;
    const budget = maxTokens - sysTokens - tailTokens;

    const recent = [];
    let recentTokens = 0;
    const history = rest.slice(0, Math.max(0, lastUserIdx));
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i];
      const tokens = estimateMessageTokens(message);
      if (recentTokens + tokens > budget) break;
      recent.unshift(message);
      recentTokens += tokens;
    }

    const result = [];
    if (sysMsg) result.push(sysMsg);
    result.push(...recent, ...keepTail);
    return result;
  }

  function apiMessagesTokenCount(messages) {
    return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  }

  function estimateMessageTokens(msg) {
    const content = msg?.content;
    const files = Array.isArray(msg?.files) ? msg.files : [];
    if (typeof content === 'string') return estimateTokens(content);
    if (!Array.isArray(content)) return estimateTokens(JSON.stringify(content || ''));

    const fileHelpers = attachments();
    const filesById = new Map(files.filter(file => file?.fileId).map(file => [file.fileId, file]));
    return content.reduce((sum, part) => {
      if (part?.type === 'text' && part.attachmentFileId) {
        const file = filesById.get(part.attachmentFileId);
        const inlineText = file && fileHelpers?.fileTextInline ? fileHelpers.fileTextInline(file) : '';
        if (inlineText && part.text !== inlineText) return sum + estimateTokens(inlineText);
      }
      if (part?.type === 'text') return sum + estimateTokens(part.text || '');
      if (part?.type === 'image_url') return sum + 512;
      return sum + estimateTokens(JSON.stringify(part || ''));
    }, 0);
  }

  function formatTokenCount(value) {
    const n = Math.max(0, Math.round(value || 0));
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
    return String(n);
  }

  root.OwnChatTokens = {
    DEFAULT_CONTEXT_LIMIT,
    TOKEN_K,
    estimateTokens,
    tokensToK,
    kToTokens,
    explicitMaxTokens,
    trimContextMessages,
    apiMessagesTokenCount,
    estimateMessageTokens,
    formatTokenCount,
  };
})();

// OwnChat Service Worker — sole proxy for chat stream and image generation
const STREAM_KEY = 'active_stream';
const IMAGE_KEY = 'active_image';
const STREAM_DB_NAME = 'ownchat_stream_db';
const STREAM_DB_VERSION = 2;
const STREAM_STORE = 'sessions';

let activeStreamAbort = null;
let activeStreamOwnerId = '';
let activeImageAbort = null;
let activeImageOwnerId = '';
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

async function updateImageSession(session, opts = {}) {
  await notifyClients({ type: 'image-session', session });
  if (opts.persist === false) return;
  await updateStreamData(session);
}

self.addEventListener('message', (event) => {
  if (!isAllowedClient(event) || !isValidMessage(event.data)) return;
  if (event.data?.type === 'start-stream') {
    keepAlive(event, startStream(event.data));
  }
  if (event.data?.type === 'stop-stream') {
    if (activeStreamAbort && (!event.data.ownerId || event.data.ownerId === activeStreamOwnerId)) {
      activeStreamAbort.abort();
      activeStreamAbort = null;
      activeStreamOwnerId = '';
    }
  }
  if (event.data?.type === 'start-image') {
    keepAlive(event, startImage(event.data));
  }
  if (event.data?.type === 'stop-image') {
    if (activeImageAbort && (!event.data.ownerId || event.data.ownerId === activeImageOwnerId)) {
      activeImageStopStatus = event.data?.status === 'timeout' ? 'timeout' : 'stopped';
      activeImageAbort.abort();
      activeImageAbort = null;
      activeImageOwnerId = '';
    }
  }
});

function isAllowedClient(event) {
  try {
    if (!event.source?.url) return true;
    return new URL(event.source.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

function isSafeRequestUrl(url) {
  try {
    const parsed = new URL(url, self.location.href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isHeaderMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isValidMessage(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.type === 'stop-stream' || data.type === 'stop-image') return true;
  if (data.type !== 'start-stream' && data.type !== 'start-image') return false;
  if (!isSafeRequestUrl(data.url) || !isHeaderMap(data.headers)) return false;
  if (data.type === 'start-stream') return typeof data.body === 'string';
  if (data.requestType === 'edit') return !!data.formParams;
  return typeof data.body === 'string';
}

// ===== Chat Stream Proxy =====
async function startStream(data) {
  const { url, headers, body, convId, model } = data;
  const controller = new AbortController();
  activeStreamAbort = controller;
  activeStreamOwnerId = data.ownerId || '';
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
    ownerId: data.ownerId || '',
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
          activeStreamOwnerId = '';
          return;
        }
      }
      if (!resp.ok) {
        await updateStreamData({ status: 'error', updatedAt: Date.now(), error: OwnChatStream.httpErrorText(resp.status, errText) });
        activeStreamAbort = null;
        activeStreamOwnerId = '';
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
        activeStreamOwnerId = '';
        return;
      }
      const erroredAt = Date.now();
      await updateStreamData(OwnChatStream.finalizeChatStream(streamState, 'error', erroredAt, { error: String(e.message || e) }));
    }
  } catch (e) {
    if (e?.name === 'AbortError') {
      await updateStreamData({ status: 'stopped', updatedAt: Date.now() });
      activeStreamAbort = null;
      activeStreamOwnerId = '';
      return;
    }
    await updateStreamData({ status: 'error', updatedAt: Date.now(), error: OwnChatStream.fetchErrorText(e) });
  }
  activeStreamAbort = null;
  activeStreamOwnerId = '';
}

// ===== Image Generation Proxy =====
async function startImage(data) {
  const { jobId, requestType } = data;
  const controller = new AbortController();
  activeImageAbort = controller;
  activeImageOwnerId = data.ownerId || '';
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
    ownerId: data.ownerId || '',
    status: 'connecting', startedAt, timeoutMs, updatedAt: Date.now(), outputs: '', error: '',
  });
  const heartbeat = setInterval(() => {
    updateStreamData({ id: IMAGE_KEY, updatedAt: Date.now() });
  }, 15000);

  try {
    const requestCount = Math.max(1, Math.min(10, Math.round(Number(data.count) || 1)));
    const fetchOnce = async () => {
      let resp;
      if (requestType === 'generations' || requestType === 'responses') {
        resp = await fetch(data.url, {
          method: 'POST',
          headers: data.headers,
          body: OwnChatImageShared.sanitizeImageRequestBody(data.body),
          signal: controller.signal,
        });
      } else if (requestType === 'edit') {
        const form = new FormData();
        const params = data.formParams;
        form.append('model', params.model);
        form.append('prompt', params.prompt);
        form.append('n', '1');
        const images = Array.isArray(params.images) && params.images.length
          ? params.images
          : (params.imageBase64 ? [{ base64: params.imageBase64, filename: params.imageFilename }] : []);
        images.forEach(item => {
          const imageBlob = OwnChatImageShared.dataUrlToBlob(item.base64);
          form.append('image', imageBlob, item.filename || 'reference.png');
        });
        if (params.size && params.size !== 'auto') form.append('size', params.size);
        if (params.quality && params.quality !== 'auto') form.append('quality', params.quality);
        if (params.outputFormat && !/^dall-e/i.test(params.model)) form.append('output_format', params.outputFormat);
        if (
          params.background &&
          params.background !== 'auto' &&
          !(params.background === 'transparent' && OwnChatImageShared.imageModelDisallowsTransparentBackground(params.model || ''))
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
      if (!resp) throw new Error('No response received');
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(OwnChatStream.httpErrorText(resp.status, errText));
      }
      return resp.json();
    };

    const outputFromValue = value => {
      if (!value || typeof value !== 'object') return;
      const b64 = value.b64_json || value.b64 || value.image_base64 || value.result || '';
      const url = value.url || value.image_url || '';
      if (!b64 && !url) return null;
      return {
        b64,
        url,
        revisedPrompt: value.revised_prompt || value.revisedPrompt || '',
        format: OwnChatImageShared.normalizeImageFormat(value.output_format || value.mime_type || data.outputFormat || 'png'),
        bytes: b64 ? Math.ceil(b64.length * 3 / 4) : 0,
        createdAt: Date.now(),
      };
    };
    const parseResultOutputs = result => {
      const parsedOutputs = [];
      const pushImageOutput = value => {
        const output = outputFromValue(value);
        if (output) parsedOutputs.push(output);
      };
      const scanResponse = value => {
        if (!value) return;
        if (Array.isArray(value)) { value.forEach(scanResponse); return; }
        if (typeof value !== 'object') return;
        pushImageOutput(value);
        Object.keys(value).forEach(k => scanResponse(value[k]));
      };
      if (requestType === 'generations' || requestType === 'edit') (result.data || []).forEach(pushImageOutput);
      else if (requestType === 'responses') scanResponse(result.output || result);
      return parsedOutputs;
    };
    const combineUsages = usages => usages.length ? usages.reduce((combined, item) => {
      ['input', 'output', 'total'].forEach(key => {
        if (Number.isFinite(item[key])) combined[key] = (combined[key] || 0) + item[key];
      });
      if (item.details) {
        combined.details = combined.details || {};
        ['inputImage', 'inputText', 'outputImage', 'outputText'].forEach(key => {
          if (Number.isFinite(item.details[key])) combined.details[key] = (combined.details[key] || 0) + item.details[key];
        });
      }
      return combined;
    }, {}) : null;

    const outputs = [];
    const usages = [];
    let completedCount = 0;
    let successCount = 0;
    let failedCount = 0;
    const publishProgress = async () => {
      await updateImageSession({
        id: IMAGE_KEY, jobId, requestType, startedAt, timeoutMs,
        status: 'streaming', updatedAt: Date.now(),
        outputs: JSON.stringify(outputs),
        usage: combineUsages(usages),
        completedCount,
        successCount,
        failedCount,
        totalCount: requestCount,
      }, { persist: false });
    };
    const settled = await Promise.allSettled(Array.from({ length: requestCount }, async () => {
      try {
        const result = await fetchOnce();
        const resultOutputs = parseResultOutputs(result);
        if (!resultOutputs.length) throw new Error('接口未返回可显示的图片数据');
        const usage = OwnChatImageShared.normalizeImageUsage(result.usage || result.response?.usage);
        outputs.push(...resultOutputs);
        successCount += resultOutputs.length;
        if (usage) usages.push(usage);
        completedCount += 1;
        await publishProgress();
        return result;
      } catch (error) {
        failedCount += 1;
        completedCount += 1;
        await publishProgress();
        throw error;
      }
    }));
    if (controller.signal.aborted) {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
    const failed = settled.filter(item => item.status === 'rejected');
    if (!outputs.length) {
      const firstError = failed[0]?.reason;
      throw firstError || new Error('接口未返回可显示的图片数据');
    }
    if (!settled.some(item => item.status === 'fulfilled') && failed.length) {
      throw failed[0].reason || new Error('No response received');
    }
    if (!outputs.length) throw new Error('接口未返回可显示的图片数据');

    const usage = combineUsages(usages);
    await updateImageSession({
      id: IMAGE_KEY, jobId, requestType, startedAt, timeoutMs,
      status: 'complete', updatedAt: Date.now(),
      outputs: JSON.stringify(outputs),
      usage,
      completedCount: requestCount,
      successCount,
      failedCount,
      totalCount: requestCount,
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
      activeImageOwnerId = '';
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
    if (activeImageOwnerId === (data.ownerId || '')) activeImageOwnerId = '';
    activeImageStopStatus = 'stopped';
  }
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
