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
