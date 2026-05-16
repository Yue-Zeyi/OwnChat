(function () {
  'use strict';

  const DEFAULT_CONTEXT_LIMIT = 256000;
  const TOKEN_K = 1000;

  function attachments() {
    return window.OwnChatAttachments;
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

    const head = [];
    let headTokens = 0;
    for (const message of rest.slice(0, Math.max(0, lastUserIdx))) {
      const tokens = estimateMessageTokens(message);
      if (headTokens + tokens > budget) break;
      head.push(message);
      headTokens += tokens;
    }

    const result = [];
    if (sysMsg) result.push(sysMsg);
    result.push(...head, ...keepTail);
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

  window.OwnChatTokens = {
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
