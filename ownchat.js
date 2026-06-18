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

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('参考图读取失败'));
      reader.readAsDataURL(blob);
    });
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
    blobToDataUrl,
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

// ===== Storage =====
(function () {
  'use strict';

  const KEYS = {
    baseUrl: 'nc_base_url',
    apiKey: 'nc_api_key',
    model: 'nc_model',
    modelsCache: 'nc_models_cache',
    chatEndpoints: 'nc_chat_endpoints',
    currentChatEndpointId: 'nc_current_chat_endpoint_id',
    conversations: 'nc_conversations',
    currentConvId: 'nc_current_conv_id',
    sidebarCollapsed: 'nc_sidebar_collapsed',
    theme: 'nc_theme',
    mode: 'nc_mode',
    imageBaseUrl: 'nc_image_base_url',
    imageApiKey: 'nc_image_api_key',
    imageModel: 'nc_image_model',
    imageMapModel: 'nc_image_map_model',
    imagePromptModel: 'nc_image_prompt_model',
    imageModelsCache: 'nc_image_models_cache',
    imageEndpoints: 'nc_image_endpoints',
    currentImageEndpointId: 'nc_current_image_endpoint_id',
    currentImageJobId: 'nc_current_image_job_id',
    imageDefaults: 'nc_image_defaults',
    imageCanvasMode: 'nc_image_canvas_mode',
  };

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn('localStorage save failed:', key, error);
    }
  }

  function load(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  window.OwnChatStorage = { KEYS, save, load };
})();

// ===== Markdown Rendering =====
(function () {
  'use strict';

  const mdCopyIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const MarkdownIt = window.markdownit || (typeof markdownit !== 'undefined' ? markdownit : null);
  const mdParser = MarkdownIt ? MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
    highlight(code, lang) {
      const safeLang = (lang || '').trim();
      const highlighted = highlightCode(code.replace(/\n$/, ''), safeLang);
      return `<div class="code-block">${codeHeader(safeLang)}<pre><code>${highlighted}</code></pre></div>`;
    },
  }) : null;

  if (mdParser) {
    mdParser.core.ruler.after('inline', 'ownchat-task-list', (state) => {
      const tokens = state.tokens;
      for (let i = 2; i < tokens.length; i++) {
        if (tokens[i].type !== 'inline') continue;
        if (tokens[i - 1]?.type !== 'paragraph_open' || tokens[i - 2]?.type !== 'list_item_open') continue;

        const match = tokens[i].content.match(/^\[([ xX])\]\s+/);
        if (!match) continue;

        const checked = match[1].trim() !== '';
        tokens[i - 2].attrJoin('class', checked ? 'task-item task-checked' : 'task-item task-unchecked');
        tokens[i].content = tokens[i].content.slice(match[0].length);
        tokens[i].children = tokens[i].children || [];
        if (tokens[i].children[0]?.type === 'text') {
          tokens[i].children[0].content = tokens[i].children[0].content.slice(match[0].length);
        }

        const marker = new state.Token('html_inline', '', 0);
        marker.content = `<span class="task-box">${checked ? '✓' : ''}</span>`;
        tokens[i].children.unshift(marker);
      }
    });

    const defaultLinkOpen = mdParser.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    mdParser.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const hrefIdx = token.attrIndex('href');
      if (hrefIdx >= 0) {
        token.attrs[hrefIdx][1] = sanitizeUrlValue(token.attrs[hrefIdx][1]);
      }
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
      return defaultLinkOpen(tokens, idx, options, env, self);
    };
    mdParser.renderer.rules.image = (tokens, idx) => {
      const token = tokens[idx];
      const src = token.attrGet('src') || '';
      const alt = token.content || '';
      return `<img src="${sanitizeUrl(src, { image: true })}" alt="${esc(stripMd(alt))}" loading="lazy">`;
    };
    mdParser.renderer.rules.fence = (tokens, idx, options) => {
      const token = tokens[idx];
      const lang = token.info ? token.info.trim().split(/\s+/)[0] : '';
      const highlighted = options.highlight ? options.highlight(token.content, lang, '') : esc(token.content);
      return highlighted || `<pre><code>${esc(token.content)}</code></pre>`;
    };
  }

  function codeHeader(lang) {
    const langLabel = lang ? `<span class="code-lang">${esc(lang)}</span>` : '';
    return `<div class="code-header">${langLabel}<button class="code-copy-btn" type="button" title="复制代码">${mdCopyIcon}</button></div>`;
  }

  function renderMd(raw) {
    if (!raw) return '';
    if (mdParser) return mdParser.render(raw);
    return esc(raw).replace(/\n/g, '<br>');
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[char]);
  }

  function stripMd(text) {
    return String(text ?? '').replace(/[*_~`[\]]/g, '');
  }

  function sanitizeUrl(rawUrl, opts = {}) {
    return esc(sanitizeUrlValue(rawUrl, opts));
  }

  function sanitizeUrlValue(rawUrl, opts = {}) {
    const url = String(rawUrl ?? '').trim().replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if (!url) return '#';
    if (opts.image && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(url)) return url;
    try {
      const parsed = new URL(url, window.location.href);
      const allowed = opts.image ? ['http:', 'https:'] : ['http:', 'https:', 'mailto:', 'tel:'];
      if (allowed.includes(parsed.protocol)) return url;
    } catch {
      if (!opts.image && /^(#|\/(?!\/)|\.{1,2}\/)/.test(url)) return url;
    }
    return '#';
  }

  function splitThinkTags(raw) {
    const text = raw || '';
    const contentParts = [];
    const reasoningParts = [];
    const tagRe = /<\/?think>/ig;
    let last = 0;
    let inThink = false;
    let sawThink = false;
    let match;

    while ((match = tagRe.exec(text))) {
      sawThink = true;
      if (/^<think>$/i.test(match[0])) {
        if (inThink) {
          reasoningParts.push(text.slice(last, match.index));
        } else {
          contentParts.push(text.slice(last, match.index));
          inThink = true;
        }
      } else if (inThink) {
        reasoningParts.push(text.slice(last, match.index));
        inThink = false;
      } else {
        contentParts.push(text.slice(last, match.index));
      }
      last = match.index + match[0].length;
    }

    if (inThink) reasoningParts.push(text.slice(last));
    else contentParts.push(text.slice(last));

    const reasoning = reasoningParts.join('').replace(/^\s+|\s+$/g, '');
    const content = sawThink ? contentParts.join('').replace(/^\s+/, '') : text;
    return { reasoning, content, openThink: inThink };
  }

  function highlightCode(code, lang) {
    const regions = [];
    const add = (start, end, cls) => regions.push({ start, end, cls });

    const stringRegions = [];
    for (const match of code.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      add(match.index, match.index + match[0].length, 'hl-string');
      stringRegions.push([match.index, match.index + match[0].length]);
    }
    for (const match of code.matchAll(/'(?:[^'\\]|\\.)*'/g)) {
      add(match.index, match.index + match[0].length, 'hl-string');
      stringRegions.push([match.index, match.index + match[0].length]);
    }

    const inString = idx => stringRegions.some(([start, end]) => idx >= start && idx < end);

    for (const match of code.matchAll(/\/\*[\s\S]*?\*\//g)) {
      if (!inString(match.index)) add(match.index, match.index + match[0].length, 'hl-comment');
    }
    for (const match of code.matchAll(/\/\/.*$/gm)) {
      if (!inString(match.index)) add(match.index, match.index + match[0].length, 'hl-comment');
    }
    if (/^(py|python|rb|ruby|sh|bash|yaml|yml|toml|r|perl|pl)/i.test(lang)) {
      for (const match of code.matchAll(/#.*$/gm)) {
        if (!inString(match.index)) add(match.index, match.index + match[0].length, 'hl-comment');
      }
    }

    const kwSet = new Set(['function','return','if','else','for','while','do','switch','case','break','continue','class','extends','new','this','super','import','export','from','default','async','await','try','catch','finally','throw','const','let','var','def','elif','lambda','with','as','in','not','is','True','False','None','print','self','yield','raise','except','pass','assert','struct','enum','interface','type','namespace','using','public','private','protected','static','final','void','int','float','double','string','bool','char','long','short','byte','sizeof','null','undefined','true','false','typeof','instanceof']);
    for (const match of code.matchAll(/\b([a-zA-Z_]\w*)\b/g)) {
      if (kwSet.has(match[1])) add(match.index, match.index + match[0].length, 'hl-keyword');
    }
    for (const match of code.matchAll(/\b(\d+\.?\d*)\b/g)) add(match.index, match.index + match[0].length, 'hl-number');
    for (const match of code.matchAll(/\b([a-zA-Z_]\w*)(\s*\()/g)) {
      if (!kwSet.has(match[1])) add(match.index, match.index + match[1].length, 'hl-func');
    }

    regions.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

    const kept = [];
    for (const region of regions) {
      if (kept.length && region.start < kept[kept.length - 1].end) continue;
      kept.push(region);
    }

    let html = '';
    let pos = 0;
    for (const region of kept) {
      if (region.start > pos) html += esc(code.slice(pos, region.start));
      html += `<span class="${region.cls}">${esc(code.slice(region.start, region.end))}</span>`;
      pos = region.end;
    }
    if (pos < code.length) html += esc(code.slice(pos));
    return html;
  }

  window.OwnChatMarkdown = {
    renderMd,
    esc,
    stripMd,
    sanitizeUrl,
    sanitizeUrlValue,
    splitThinkTags,
    highlightCode,
  };
})();

// ===== Attachments =====
(function () {
  'use strict';

  const TEXT_FILE_INLINE_MAX_BYTES = 1024 * 1024;
  const EXTRACTABLE_FILE_MAX_BYTES = 10 * 1024 * 1024;
  const PDF_TEXT_EXTRACT_MAX_BYTES = 10 * 1024 * 1024;
  const TEXT_FILE_EXTENSIONS = new Set([
    'txt', 'md', 'csv', 'json', 'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css',
    'xml', 'yaml', 'yml', 'php', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
    'cs', 'rb', 'swift', 'kt', 'kts', 'vue', 'svelte', 'sh', 'bash', 'zsh',
    'sql', 'toml', 'ini', 'env', 'log', 'tsv'
  ]);
  const EXTRACTABLE_FILE_EXTENSIONS = new Set(['docx', 'rtf', 'odt', 'pptx', 'xlsx']);
  const UNSUPPORTED_BINARY_EXTENSIONS = new Set(['doc', 'ppt', 'xls']);
  const IMAGE_FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif']);

  function fileExtension(name = '') {
    const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
  }

  function isPdfFile(file) {
    return fileExtension(file?.name) === 'pdf' || (file?.type || '').toLowerCase() === 'application/pdf';
  }

  function isImageFile(file) {
    return (file?.type || '').toLowerCase().startsWith('image/') || IMAGE_FILE_EXTENSIONS.has(fileExtension(file?.name));
  }

  function isTextFile(file) {
    if (isImageFile(file)) return false;
    const ext = fileExtension(file?.name);
    if (isPdfFile(file) || EXTRACTABLE_FILE_EXTENSIONS.has(ext) || UNSUPPORTED_BINARY_EXTENSIONS.has(ext)) return false;
    const type = (file?.type || '').toLowerCase();
    if (type.startsWith('text/')) return true;
    if (/json|xml|csv|yaml|markdown|javascript|typescript|x-sh|x-shellscript|x-php|x-python|sql|toml/.test(type)) return true;
    return TEXT_FILE_EXTENSIONS.has(ext);
  }

  function isExtractableFile(file) {
    return EXTRACTABLE_FILE_EXTENSIONS.has(fileExtension(file?.name));
  }

  function unsupportedAttachmentReason(file) {
    if (isImageFile(file)) return '';
    const ext = fileExtension(file?.name);
    if (UNSUPPORTED_BINARY_EXTENSIONS.has(ext)) {
      const target = ext === 'doc' ? 'docx' : (ext === 'ppt' ? 'pptx' : 'xlsx');
      return `${file?.name || '附件'} 是旧版 Office 二进制格式，请转为 ${target} 或 PDF 后上传`;
    }
    if (!isTextFile(file) && !isExtractableFile(file) && !isPdfFile(file)) {
      return `${file?.name || '附件'} 当前不支持，请转为文本、PDF 或新版 Office 文件`;
    }
    return '';
  }

  function maxChatAttachmentBytes(file) {
    if (isImageFile(file)) return null;
    const ext = fileExtension(file?.name);
    if (isTextFile(file)) return TEXT_FILE_INLINE_MAX_BYTES;
    if (EXTRACTABLE_FILE_EXTENSIONS.has(ext)) return EXTRACTABLE_FILE_MAX_BYTES;
    if (isPdfFile(file)) return PDF_TEXT_EXTRACT_MAX_BYTES;
    return 0;
  }

  function storedTextBytes(value) {
    if (value == null) return 0;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text) return 0;
    if (typeof Blob !== 'undefined') return new Blob([text]).size;
    return new TextEncoder().encode(text).length;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(mb >= 100 ? 0 : 2)} MB`;
  }

  function validateReadyFiles(files) {
    const unsupported = files.find(f => unsupportedAttachmentReason(f));
    if (unsupported) return [unsupportedAttachmentReason(unsupported)];
    const oversizedText = files.find(f => typeof f.text === 'string' && storedTextBytes(f.text) > TEXT_FILE_INLINE_MAX_BYTES);
    if (oversizedText) return [`${oversizedText.name || '附件'} 超过 ${formatBytes(TEXT_FILE_INLINE_MAX_BYTES)}，无法作为内联文本发送`];
    return [];
  }

  function createPendingEntry(file, name) {
    return { name: name || file?.name || 'attachment', size: file?.size || 0, type: file?.type || '', loading: true };
  }

  function isReady(entry) {
    return !!(entry && !entry.loading && !entry.error && (entry.base64 || typeof entry.text === 'string'));
  }

  function hasError(entry) {
    return !!entry?.error;
  }

  function isLoading(entry) {
    return !!entry?.loading || (!hasError(entry) && !isReady(entry));
  }

  function failEntry(entry, message) {
    entry.loading = false;
    entry.error = true;
    entry.errorText = message || '读取失败';
    return entry;
  }

  async function readIntoEntry(entry, file) {
    const unsupportedReason = unsupportedAttachmentReason(entry);
    if (unsupportedReason) {
      return failEntry(entry, unsupportedReason.replace(`${entry.name} `, ''));
    }
    const maxBytes = maxChatAttachmentBytes(entry);
    if (maxBytes !== null && (file?.size || 0) > maxBytes) {
      return failEntry(entry, `超过 ${formatBytes(maxBytes)}`);
    }
    try {
      Object.assign(entry, await readAttachment(file));
      entry.loading = false;
      delete entry.error;
      delete entry.errorText;
    } catch (err) {
      failEntry(entry, err?.message || '读取失败');
    }
    return entry;
  }

  function fileTextInline(file) {
    if (typeof file?.text === 'string') {
      const source = file.extractionLabel ? ` · ${file.extractionLabel}` : '';
      return `[文件: ${file.name || '附件'}${source}]\n${file.text}`;
    }
    return `[文件: ${file?.name || '附件'}]\n此文件不是文本/代码文件，当前接口无法直接读取正文。`;
  }

  function promptPartsFromReadyFiles(userText, files) {
    const contentParts = [{ type: 'text', text: userText }];
    for (const file of files) {
      if (file.base64) {
        contentParts.push({ type: 'image_url', image_url: { url: file.base64 } });
      } else {
        contentParts.push({ type: 'text', text: fileTextInline(file) });
      }
    }
    return contentParts;
  }

  function metadataFromReadyFiles(files) {
    return files.map(file => ({
      name: file.name,
      type: file.type,
      size: file.size,
      base64: file.base64,
      text: file.text,
      extractionLabel: file.extractionLabel,
    }));
  }

  function messageFromReadyFiles(userText, files, meta = {}) {
    return Object.assign({
      role: 'user',
      content: promptPartsFromReadyFiles(userText, files),
      files: metadataFromReadyFiles(files),
    }, meta);
  }

  function apiMessagesFromPromptMessages(messages) {
    return messages.map(msg => {
      if (typeof msg.content === 'string') return { role: msg.role, content: msg.content };
      if (Array.isArray(msg.content)) {
        const content = msg.content.filter(part => part?.type === 'text' || part?.type === 'image_url');
        if (content.every(part => part?.type === 'text')) {
          return { role: msg.role, content: content.map(part => part.text || '').filter(Boolean).join('\n\n') };
        }
        return { role: msg.role, content };
      }
      return { role: msg.role, content: String(msg.content || '') };
    });
  }

  function xmlTextContent(xml) {
    return String(xml || '')
      .replace(/<w:tab\s*\/>/g, '\t')
      .replace(/<w:br\s*\/>|<text:line-break\s*\/>|<a:br\s*\/>/g, '\n')
      .replace(/<\/w:p>|<\/text:p>|<\/a:p>/g, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function rtfToText(rtf) {
    return String(rtf || '')
      .replace(/\\'[0-9a-fA-F]{2}/g, match => String.fromCharCode(parseInt(match.slice(2), 16)))
      .replace(/\\par[d]?|\\line/g, '\n')
      .replace(/\\tab/g, '\t')
      .replace(/\\u(-?\d+)\??/g, (_, code) => String.fromCharCode(Number(code) < 0 ? Number(code) + 65536 : Number(code)))
      .replace(/[{}]/g, '')
      .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
      .replace(/\\[^a-zA-Z\s]/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function extractPdfTextWithPdfJs(arrayBuffer) {
    const pdfjs = window.pdfjsLib;
    if (!pdfjs?.getDocument) throw new Error('PDF.js 不可用');
    if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
    }
    const pdf = await pdfjs.getDocument({ data: arrayBuffer.slice(0) }).promise;
    const pages = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      const text = content.items.map(item => item.str || '').join(' ').replace(/[ \t]{2,}/g, ' ').trim();
      if (text) pages.push(`## 第 ${pageNo} 页\n${text}`);
    }
    return pages.join('\n\n').trim();
  }

  async function extractDocxTextWithMammoth(arrayBuffer) {
    if (!window.mammoth?.extractRawText) throw new Error('Mammoth 不可用');
    const result = await window.mammoth.extractRawText({ arrayBuffer: arrayBuffer.slice(0) });
    return (result.value || '').trim();
  }

  function extractXlsxTextWithSheetJs(arrayBuffer) {
    if (!window.XLSX?.read) throw new Error('SheetJS 不可用');
    const workbook = window.XLSX.read(arrayBuffer, { type: 'array' });
    return workbook.SheetNames.map(name => {
      const csv = window.XLSX.utils.sheet_to_csv(workbook.Sheets[name], { blankrows: false }).trim();
      return csv ? `## ${name}\n${csv}` : '';
    }).filter(Boolean).join('\n\n').trim();
  }

  async function readZipEntriesWithJsZip(arrayBuffer, wantedNames) {
    if (!window.JSZip?.loadAsync) throw new Error('JSZip 不可用');
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    const entries = new Map();
    for (const name of wantedNames) {
      const item = zip.file(name);
      if (item) entries.set(name, await item.async('string'));
    }
    return entries;
  }

  async function extractZipXmlText(arrayBuffer, wantedNames) {
    return readZipEntriesWithJsZip(arrayBuffer, wantedNames);
  }

  function rowsToCsv(rows) {
    return rows
      .filter(row => row.some(cell => String(cell || '').trim()))
      .map(row => row.map(cell => {
        const value = String(cell || '').replace(/\s+/g, ' ').trim();
        return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
      }).join(','))
      .join('\n');
  }

  function columnNameToIndex(name) {
    let index = 0;
    for (const char of name) index = index * 26 + char.charCodeAt(0) - 64;
    return index - 1;
  }

  function extractXlsxText(entries) {
    const sharedXml = entries.get('xl/sharedStrings.xml') || '';
    const sharedStrings = Array.from(sharedXml.matchAll(/<si\b[\s\S]*?<\/si>/g)).map(match => xmlTextContent(match[0]));
    const sheetRows = [];
    for (const [name, xml] of entries) {
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
      const rows = [];
      for (const rowMatch of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
        const row = [];
        for (const cellMatch of rowMatch[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const attrs = cellMatch[1];
          const body = cellMatch[2];
          const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
          const col = ref ? columnNameToIndex(ref) : row.length;
          const type = attrs.match(/\bt="([^"]+)"/)?.[1] || '';
          let value = '';
          if (type === 'inlineStr') value = xmlTextContent(body);
          else {
            const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '';
            value = type === 's' ? (sharedStrings[Number(raw)] || '') : raw;
          }
          row[col] = value;
        }
        rows.push(row);
      }
      const csv = rowsToCsv(rows);
      if (csv) sheetRows.push(`## ${name.split('/').pop()}\n${csv}`);
    }
    return sheetRows.join('\n\n').trim();
  }

  async function extractDocumentText(file, arrayBuffer) {
    const ext = fileExtension(file.name);
    if (ext === 'rtf') return { text: rtfToText(new TextDecoder().decode(arrayBuffer)), label: 'RTF 提取文本' };
    if (ext === 'pdf') {
      try {
        const text = await extractPdfTextWithPdfJs(arrayBuffer);
        if (text) return { text, label: 'PDF.js 提取文本' };
      } catch (err) {
        throw new Error(err?.message || 'PDF.js 提取失败');
      }
      return { text: '', label: 'PDF.js 提取文本' };
    }

    if (ext === 'docx') {
      try {
        const text = await extractDocxTextWithMammoth(arrayBuffer);
        if (text) return { text, label: 'Mammoth 提取文本' };
      } catch { /* fall back to XML extraction */ }
      const entries = await extractZipXmlText(arrayBuffer, ['word/document.xml']);
      return { text: xmlTextContent(entries.get('word/document.xml')), label: 'DOCX 提取文本' };
    }
    if (ext === 'odt') {
      const entries = await extractZipXmlText(arrayBuffer, ['content.xml']);
      return { text: xmlTextContent(entries.get('content.xml')), label: 'ODT 提取文本' };
    }
    if (ext === 'pptx') {
      const wanted = [];
      for (let i = 1; i <= 120; i++) wanted.push(`ppt/slides/slide${i}.xml`);
      const entries = await extractZipXmlText(arrayBuffer, wanted);
      const slides = [];
      for (const [name, xml] of entries) {
        const text = xmlTextContent(xml);
        if (text) slides.push(`## ${name.split('/').pop()}\n${text}`);
      }
      return { text: slides.join('\n\n'), label: 'PPTX 提取文本' };
    }
    if (ext === 'xlsx') {
      try {
        const text = extractXlsxTextWithSheetJs(arrayBuffer);
        if (text) return { text, label: 'SheetJS 提取表格' };
      } catch { /* fall back to XML extraction */ }
      const wanted = ['xl/sharedStrings.xml'];
      for (let i = 1; i <= 80; i++) wanted.push(`xl/worksheets/sheet${i}.xml`);
      const entries = await extractZipXmlText(arrayBuffer, wanted);
      return { text: extractXlsxText(entries), label: 'XLSX 提取文本' };
    }
    return { text: '', label: '' };
  }

  async function readAttachment(file) {
    const readAsDataUrl = () => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = ev => resolve(ev.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const readAsText = () => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = ev => resolve(ev.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
    const readAsArrayBuffer = () => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = ev => resolve(ev.target.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });

    if (isImageFile(file)) {
      return { base64: await readAsDataUrl() };
    }
    if (isTextFile(file)) {
      return { text: await readAsText(), extractionLabel: '文本文件' };
    }
    if (isExtractableFile(file) || isPdfFile(file)) {
      const extracted = await extractDocumentText(file, await readAsArrayBuffer());
      if (!extracted.text.trim()) {
        throw new Error(isPdfFile(file) ? '未提取到文本，可能是扫描版 PDF' : '未提取到文本');
      }
      if (storedTextBytes(extracted.text) > TEXT_FILE_INLINE_MAX_BYTES) {
        throw new Error(`提取文本超过 ${formatBytes(TEXT_FILE_INLINE_MAX_BYTES)}`);
      }
      return { text: extracted.text, extractionLabel: extracted.label };
    }
    throw new Error('不支持');
  }

  window.OwnChatAttachments = {
    limits: {
      textInlineMaxBytes: TEXT_FILE_INLINE_MAX_BYTES,
      extractableFileMaxBytes: EXTRACTABLE_FILE_MAX_BYTES,
      pdfTextExtractMaxBytes: PDF_TEXT_EXTRACT_MAX_BYTES,
    },
    isTextFile,
    createPendingEntry,
    isReady,
    hasError,
    isLoading,
    storedTextBytes,
    formatBytes,
    readIntoEntry,
    validateReadyFiles,
    fileTextInline,
    messageFromReadyFiles,
    apiMessagesFromPromptMessages,
  };
})();

// ===== Persistence DB =====
(function () {
  'use strict';

  const IMAGE_DB = { name: 'ownchat_image_db', version: 3, store: 'jobs', fileStore: 'files' };
  const STREAM_KEY = 'active_stream';
  const IMAGE_KEY = 'active_image';
  const STREAM_DB_NAME = 'ownchat_stream_db';
  const STREAM_DB_VERSION = 2;
  const STREAM_STORE = 'sessions';

  let imageDbPromise = null;
  let imageDbWarned = false;
  let imageSaveErrorHandler = null;
  let streamDbPromise = null;

  function setImageSaveErrorHandler(handler) {
    imageSaveErrorHandler = typeof handler === 'function' ? handler : null;
  }

  function idbRequest(req, fallback = null) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result ?? fallback);
      req.onerror = () => reject(req.error);
    });
  }

  function idbTxDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function openImageDb() {
    if (imageDbPromise) return imageDbPromise;
    imageDbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(IMAGE_DB.name, IMAGE_DB.version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IMAGE_DB.store)) {
          const store = db.createObjectStore(IMAGE_DB.store, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains(IMAGE_DB.fileStore)) {
          db.createObjectStore(IMAGE_DB.fileStore, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return imageDbPromise;
  }

  async function imageDbGetAllJobs() {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.store, 'readonly');
      const jobs = await idbRequest(tx.objectStore(IMAGE_DB.store).getAll(), []);
      return jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch (error) {
      console.warn('Image history load failed:', error);
      return [];
    }
  }

  async function imageDbPutJob(job) {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.store, 'readwrite');
      tx.objectStore(IMAGE_DB.store).put(job);
      await idbTxDone(tx);
    } catch (error) {
      console.warn('Image history save failed:', error);
      if (!imageDbWarned) {
        imageDbWarned = true;
        if (imageSaveErrorHandler) imageSaveErrorHandler(error);
      }
    }
  }

  async function imageDbDeleteJob(id) {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.store, 'readwrite');
      tx.objectStore(IMAGE_DB.store).delete(id);
      await idbTxDone(tx);
    } catch (error) {
      console.warn('Image history delete failed:', error);
    }
  }

  async function imageDbClearJobs() {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.store, 'readwrite');
      tx.objectStore(IMAGE_DB.store).clear();
      await idbTxDone(tx);
    } catch (error) {
      console.warn('Image history clear failed:', error);
    }
  }

  async function fileDbPut(attachmentRecord) {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.fileStore, 'readwrite');
      tx.objectStore(IMAGE_DB.fileStore).put(attachmentRecord);
      await idbTxDone(tx);
      return true;
    } catch (error) {
      console.warn('File attachment save failed:', error);
      return false;
    }
  }

  async function fileDbGetAll() {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.fileStore, 'readonly');
      return await idbRequest(tx.objectStore(IMAGE_DB.fileStore).getAll(), []);
    } catch (error) {
      console.warn('File attachments load failed:', error);
      return [];
    }
  }

  async function fileDbDelete(id) {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.fileStore, 'readwrite');
      tx.objectStore(IMAGE_DB.fileStore).delete(id);
      await idbTxDone(tx);
    } catch (error) {
      console.warn('File attachment delete failed:', error);
    }
  }

  async function fileDbClearAll() {
    try {
      const db = await openImageDb();
      const tx = db.transaction(IMAGE_DB.fileStore, 'readwrite');
      tx.objectStore(IMAGE_DB.fileStore).clear();
      await idbTxDone(tx);
    } catch (error) {
      console.warn('File attachments clear failed:', error);
    }
  }

  function openStreamDb() {
    if (streamDbPromise) return streamDbPromise;
    streamDbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
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
    return streamDbPromise;
  }

  async function writeStreamSession(meta) {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readwrite');
      tx.objectStore(STREAM_STORE).put(Object.assign({ id: STREAM_KEY, assistantContent: '', reasoningContent: '', status: 'streaming', updatedAt: Date.now() }, meta));
      await idbTxDone(tx);
    } catch {
      /* ignore */
    }
  }

  async function getStreamSession() {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readonly');
      return await idbRequest(tx.objectStore(STREAM_STORE).get(STREAM_KEY), null);
    } catch {
      return null;
    }
  }

  async function getStableStreamSession(baseSession) {
    if (!baseSession || !['complete', 'error', 'stopped'].includes(baseSession.status)) return baseSession;
    await new Promise(resolve => setTimeout(resolve, 50));
    const latest = await getStreamSession();
    if (!latest || (latest.convId && baseSession.convId && latest.convId !== baseSession.convId)) return baseSession;
    return Object.assign({}, baseSession, latest);
  }

  async function clearStreamSession() {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readwrite');
      tx.objectStore(STREAM_STORE).delete(STREAM_KEY);
      await idbTxDone(tx);
    } catch {
      /* ignore */
    }
  }

  async function getImageSession() {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readonly');
      return normalizeImageSession(await idbRequest(tx.objectStore(STREAM_STORE).get(IMAGE_KEY), null));
    } catch {
      return null;
    }
  }

  function normalizeImageSession(session) {
    if (!session) return null;
    if (session.status === 'connecting') {
      if (typeof session.outputs === 'string' && session.outputs.trim()) {
        return Object.assign({}, session, { status: 'complete' });
      }
      if (session.error) {
        return Object.assign({}, session, { status: 'error' });
      }
    }
    return session;
  }

  function parseImageSessionOutputs(session) {
    try {
      const raw = session?.outputs;
      const outputs = Array.isArray(raw)
        ? raw
        : (typeof raw === 'string' && raw.trim() ? JSON.parse(raw) : []);
      if (!Array.isArray(outputs)) return [];
      const total = Math.max(1, Number(session?.totalCount) || outputs.length || 1);
      const slots = [];
      outputs.forEach((out, fallbackIndex) => {
        if (!out) return;
        const rawIndex = Number(out.requestIndex);
        const index = Number.isFinite(rawIndex) && rawIndex >= 0 ? rawIndex : fallbackIndex;
        if (index >= total) return;
        const existing = slots[index];
        if (!existing || (existing.failed && !out.failed && (out.b64 || out.url))) slots[index] = out;
      });
      return slots.filter(Boolean).slice(0, total);
    } catch {
      return [];
    }
  }

  async function clearImageSession() {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readwrite');
      tx.objectStore(STREAM_STORE).delete(IMAGE_KEY);
      await idbTxDone(tx);
    } catch {
      /* ignore */
    }
  }

  async function clearImageSessionForJob(jobId, statuses = []) {
    try {
      const session = await getImageSession();
      if (!session || session.jobId !== jobId) return;
      if (statuses.length && !statuses.includes(session.status)) return;
      await clearImageSession();
    } catch {
      /* ignore */
    }
  }

  async function writeImageSession(meta) {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readwrite');
      tx.objectStore(STREAM_STORE).put(Object.assign({ id: IMAGE_KEY, status: 'stopped', updatedAt: Date.now() }, meta));
      await idbTxDone(tx);
    } catch {
      /* ignore */
    }
  }

  function collectConversationFileIds(conversations) {
    const ids = new Set();
    for (const conv of conversations || []) {
      if (!conv) continue;
      for (const msg of conv.messages || []) {
        if (Array.isArray(msg.files)) {
          msg.files.forEach(file => {
            if (file?.fileId) ids.add(file.fileId);
          });
        }
        if (Array.isArray(msg.content)) {
          msg.content.forEach(part => {
            const fileId = part?.type === 'image_url' ? part.image_url?.fileId : null;
            if (fileId) ids.add(fileId);
          });
        }
      }
    }
    return Array.from(ids);
  }

  function collectDeletedOnlyFileIds(deletedConversations, remainingConversations) {
    const deletedIds = new Set(collectConversationFileIds(deletedConversations));
    const remainingIds = new Set(collectConversationFileIds(remainingConversations));
    return Array.from(deletedIds).filter(id => !remainingIds.has(id));
  }

  function generateFileId(convId, msgIndex, partIndex) {
    return `${convId}_${msgIndex}_${partIndex}`;
  }

  function stripFilesFromConversations(conversations) {
    const Attachments = window.OwnChatAttachments;
    const fileMap = [];
    const queuedFileIds = new Set();
    const queueFile = attachmentRecord => {
      if (!attachmentRecord?.id || queuedFileIds.has(attachmentRecord.id)) return;
      queuedFileIds.add(attachmentRecord.id);
      fileMap.push(attachmentRecord);
    };
    const stripped = conversations.map(conv => {
      const strippedConv = Object.assign({}, conv);
      strippedConv.messages = conv.messages.map((msg, msgIdx) => {
        const imageFileIds = [];
        const textFileRefs = [];
        let changed = false;
        const strippedMsg = Object.assign({}, msg);
        if (msg.files && msg.files.length) {
          strippedMsg.files = msg.files.map((file, fileIdx) => {
            const fileId = file.fileId || generateFileId(conv.id, msgIdx, fileIdx);
            if (file.base64) {
              queueFile({ id: fileId, base64: file.base64, name: file.name, type: file.type, size: file.size });
              imageFileIds.push(fileId);
              changed = true;
              return { name: file.name, type: file.type, size: file.size, fileId };
            }
            if (typeof file.text === 'string') {
              const ref = { fileId, name: file.name, type: file.type, size: file.size, text: file.text, extractionLabel: file.extractionLabel };
              queueFile({ id: fileId, text: file.text, extractionLabel: file.extractionLabel, name: file.name, type: file.type, size: file.size });
              textFileRefs.push(ref);
              changed = true;
              return { name: file.name, type: file.type, size: file.size, fileId, extractionLabel: file.extractionLabel };
            }
            if (file.fileId) {
              if ((file.type || '').startsWith('image/')) imageFileIds.push(file.fileId);
              else textFileRefs.push({ fileId: file.fileId, name: file.name, type: file.type, size: file.size, text: file.text, extractionLabel: file.extractionLabel });
            }
            return file;
          });
        }
        if (Array.isArray(msg.content)) {
          let imageIdx = 0;
          let textIdx = 0;
          strippedMsg.content = msg.content.map((part, partIdx) => {
            if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
              const fileId = part.image_url.fileId || imageFileIds[imageIdx] || generateFileId(conv.id, msgIdx, partIdx);
              imageIdx += 1;
              queueFile({ id: fileId, base64: part.image_url.url, name: '', type: 'image_url' });
              changed = true;
              return Object.assign({}, part, { image_url: { url: fileId, fileId } });
            }
            if (part.type === 'image_url' && part.image_url?.fileId) imageIdx += 1;
            if (part.type === 'text' && partIdx > 0 && textIdx < textFileRefs.length) {
              const ref = textFileRefs[textIdx];
              const expectedText = typeof ref.text === 'string' && Attachments?.fileTextInline ? Attachments.fileTextInline(ref) : '';
              if (expectedText && part.text === expectedText) {
                textIdx += 1;
                changed = true;
                return {
                  type: 'text',
                  text: `[文件: ${ref.name || '附件'}]\n附件文本已移至本地索引，加载后会自动恢复。`,
                  attachmentFileId: ref.fileId,
                };
              }
            }
            return part;
          });
        }
        return changed ? strippedMsg : msg;
      });
      return strippedConv;
    });
    return { stripped, fileMap };
  }

  async function hydrateFilesInConversations(conversations) {
    const Attachments = window.OwnChatAttachments;
    const allFiles = await fileDbGetAll();
    const fileById = new Map(allFiles.map(file => [file.id, file]));
    for (const conv of conversations) {
      for (const msg of conv.messages) {
        if (msg.files && msg.files.length) {
          for (const file of msg.files) {
            if (file.fileId) {
              const stored = fileById.get(file.fileId);
              if (stored) {
                if (stored.base64) file.base64 = stored.base64;
                if (stored.text && !file.text) file.text = stored.text;
                if (stored.extractionLabel && !file.extractionLabel) file.extractionLabel = stored.extractionLabel;
                delete file.missing;
              } else {
                file.missing = true;
              }
            }
          }
        }
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'image_url' && part.image_url?.fileId) {
              const stored = fileById.get(part.image_url.fileId);
              if (stored) {
                part.image_url.url = stored.base64;
                delete part.image_url.missing;
              } else {
                part.image_url.missing = true;
              }
            }
            if (part.type === 'text' && part.attachmentFileId) {
              const stored = fileById.get(part.attachmentFileId);
              if (stored?.text && Attachments?.fileTextInline) {
                part.text = Attachments.fileTextInline(stored);
                delete part.missing;
              } else {
                part.missing = true;
              }
            }
          }
        }
      }
    }
    return conversations;
  }

  window.OwnChatDb = {
    IMAGE_KEY,
    setImageSaveErrorHandler,
    imageDbGetAllJobs,
    imageDbPutJob,
    imageDbDeleteJob,
    imageDbClearJobs,
    fileDbPut,
    fileDbGetAll,
    fileDbDelete,
    fileDbClearAll,
    writeStreamSession,
    getStreamSession,
    getStableStreamSession,
    clearStreamSession,
    getImageSession,
    normalizeImageSession,
    parseImageSessionOutputs,
    clearImageSession,
    clearImageSessionForJob,
    writeImageSession,
    collectConversationFileIds,
    collectDeletedOnlyFileIds,
    stripFilesFromConversations,
    hydrateFilesInConversations,
  };
})();

// ===== API Client =====
(function () {
  'use strict';

  function normalizeUrl(u) {
    u = (u || '').trim();
    if (!u) throw new Error('Base URL 不能为空');
    if (!/^(https?:\/\/|\/)/i.test(u)) throw new Error('Base URL 需要以 http://、https:// 或 / 开头');
    u = u.replace(/\/+$/, '');
    if (!u.endsWith('/v1')) u += '/v1';
    return u;
  }

  function requestUrl(baseUrl, path) {
    return normalizeUrl(baseUrl) + path;
  }

  function describeNetworkError(err, url) {
    const msg = err?.message || String(err);
    if (!/Failed to fetch|NetworkError|Load failed|fetch/i.test(msg)) return err;
    let target = url;
    try { target = new URL(url, window.location.href).origin; } catch { /* keep raw url */ }
    const hints = [`浏览器没有拿到 ${target} 的可用响应`];
    try {
      const parsed = new URL(url, window.location.href);
      if (window.location.protocol === 'https:' && parsed.protocol === 'http:') {
        hints.push('当前页面是 HTTPS，但接口是 HTTP，浏览器会拦截混合内容');
      }
      if (parsed.origin !== window.location.origin) {
        hints.push('这是跨域请求，如 Network 面板显示 CORS 错误才需要检查 Access-Control-Allow-Origin');
      }
      if (/api\.openai\.com$/i.test(parsed.hostname)) {
        hints.push('浏览器直连 OpenAI API 容易被 CORS 拦截，建议通过本地或服务端代理转发');
      }
    } catch { /* ignore */ }
    if (window.location.protocol === 'file:') {
      hints.push('当前是 file:// 打开页面，建议用本地静态服务访问页面');
    }
    const message = `网络请求失败：${hints.join('；')}。请检查 Base URL、代理服务和浏览器控制台 Network 面板。`;
    const error = new Error(message);
    error.diagnostics = [
      `请求地址: ${url}`,
      `页面地址: ${window.location.href}`,
      `原始错误: ${msg}`,
      `排查建议: ${hints.join('；')}`,
    ].join('\n');
    return error;
  }

  function httpError(status, message, url, context = {}) {
    const error = new Error(message || `HTTP ${status}`);
    error.diagnostics = [
      `请求地址: ${url}`,
      `HTTP 状态: ${status}`,
      `错误信息: ${message || `HTTP ${status}`}`,
      `当前模式: ${context.mode || '未知'}`,
      `对话模型: ${context.chatModel || '未配置'}`,
      `绘画模型: ${context.imageModel || '未配置'}`,
    ].join('\n');
    return error;
  }

  async function apiFetch(url, options = {}) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw describeNetworkError(err, url);
    }
  }

  window.OwnChatApi = {
    normalizeUrl,
    requestUrl,
    describeNetworkError,
    httpError,
    apiFetch,
  };
})();

// ===== Service Worker Client =====
(function () {
  'use strict';

  let registrationPromise = null;

  function canUseServiceWorker() {
    return 'serviceWorker' in navigator && window.location.protocol !== 'file:';
  }

  function register() {
    if (!canUseServiceWorker()) return Promise.resolve(null);
    if (!registrationPromise) {
      registrationPromise = navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(e => {
        console.warn('SW registration failed:', e);
        return null;
      });
    }
    return registrationPromise;
  }

  async function ensureTarget(timeoutMs = 5000) {
    if (!canUseServiceWorker()) return null;
    if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;

    const registration = await register();
    if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
    if (registration?.active) return registration.active;

    return new Promise(resolve => {
      let done = false;
      const finish = target => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
        resolve(target || navigator.serviceWorker.controller || null);
      };
      const onControllerChange = () => finish(navigator.serviceWorker.controller);
      const timer = setTimeout(() => finish(null), timeoutMs);
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
      navigator.serviceWorker.ready.then(reg => {
        finish(navigator.serviceWorker.controller || reg.active || null);
      }).catch(() => finish(null));
    });
  }

  window.OwnChatServiceWorker = {
    canUseServiceWorker,
    register,
    ensureTarget,
  };
})();

// ===== Config Import =====
(function () {
  'use strict';

  const CONFIG_QUERY_KEYS = ['config', 'config_b64', 'oc_config', 'oc_config_b64'];

  function cleanUrl() {
    if (!window.history?.replaceState) return;
    const url = new URL(window.location.href);
    CONFIG_QUERY_KEYS.forEach(k => url.searchParams.delete(k));
    window.history.replaceState({}, document.title, url.href);
  }

  function decodeBase64Url(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return decodeURIComponent(Array.from(atob(padded), c => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
  }

  function stringValue(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  function arrayValue(value) {
    return Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()) : [];
  }

  function endpointArray(value, fallback = {}) {
    if (!Array.isArray(value)) return [];
    return value.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const model = stringValue(item.model);
      const baseUrl = stringValue(item.baseUrl, item.base_url);
      const apiKey = stringValue(item.apiKey, item.api_key);
      const name = stringValue(item.name) || `接口 ${index + 1}`;
      if (!baseUrl && !apiKey && !model && !arrayValue(item.models).length) return null;
      return {
        id: stringValue(item.id),
        name,
        baseUrl,
        apiKey,
        model,
        models: mergeUnique(model ? [model] : [], arrayValue(item.models), fallback.models || []),
      };
    }).filter(Boolean);
  }

  function mergeUnique(...lists) {
    return Array.from(new Set(lists.flat().filter(Boolean)));
  }

  function parse(text) {
    const cfg = JSON.parse(text);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('配置必须是 JSON 对象');
    return cfg;
  }

  function summary(cfg) {
    const chat = cfg.chat && typeof cfg.chat === 'object' ? cfg.chat : {};
    const image = cfg.image && typeof cfg.image === 'object' ? cfg.image : {};
    const chatEndpoints = endpointArray(chat.endpoints || cfg.chatEndpoints || cfg.chat_endpoints);
    const imageEndpoints = endpointArray(image.endpoints || cfg.imageEndpoints || cfg.image_endpoints);
    return {
      chatBaseUrl: stringValue(chat.baseUrl, chat.base_url, cfg.baseUrl, cfg.base_url),
      chatApiKey: stringValue(chat.apiKey, chat.api_key, cfg.apiKey, cfg.api_key),
      chatModel: stringValue(chat.model, cfg.model),
      chatEndpoints,
      currentChatEndpointId: stringValue(chat.currentEndpointId, chat.current_endpoint_id, cfg.currentChatEndpointId, cfg.current_chat_endpoint_id),
      imageBaseUrl: stringValue(image.baseUrl, image.base_url, cfg.imageBaseUrl, cfg.image_base_url),
      imageApiKey: stringValue(image.apiKey, image.api_key, cfg.imageApiKey, cfg.image_api_key),
      imageModel: stringValue(image.model, cfg.imageModel, cfg.image_model),
      imageEndpoints,
      currentImageEndpointId: stringValue(image.currentEndpointId, image.current_endpoint_id, cfg.currentImageEndpointId, cfg.current_image_endpoint_id),
      imageMapModel: stringValue(image.mapModel, image.map_model, cfg.imageMapModel, cfg.image_map_model),
      imagePromptModel: stringValue(image.promptModel, image.prompt_model, cfg.imagePromptModel, cfg.image_prompt_model),
      mode: stringValue(cfg.mode),
      imageDefaults: image.defaults && typeof image.defaults === 'object' ? image.defaults : null,
      chatModels: mergeUnique(arrayValue(chat.models), arrayValue(cfg.models)),
      imageModels: mergeUnique(arrayValue(image.models), arrayValue(cfg.imageModels), arrayValue(cfg.image_models)),
      hasImageMapModel: 'mapModel' in image || 'map_model' in image || 'imageMapModel' in cfg || 'image_map_model' in cfg,
      hasImagePromptModel: 'promptModel' in image || 'prompt_model' in image || 'imagePromptModel' in cfg || 'image_prompt_model' in cfg,
    };
  }

  function maskKey(value) {
    if (!value) return '未提供';
    if (value.length <= 10) return `${value.slice(0, 3)}***`;
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  }

  function fromCurrentUrl() {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('config') || params.get('oc_config');
    const rawB64 = params.get('config_b64') || params.get('oc_config_b64');
    if (!raw && !rawB64) return null;
    return parse(rawB64 ? decodeBase64Url(rawB64) : raw);
  }

  window.OwnChatConfigImport = {
    cleanUrl,
    decodeBase64Url,
    parse,
    summary,
    maskKey,
    fromCurrentUrl,
  };
})();

// ===== UI Utilities =====
(function () {
  'use strict';

  const icons = {
    person: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>',
    copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    refresh: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-8.36L23 10"/></svg>',
    edit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    download: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    maximize: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
    aiAvatar: '<div class="ai-avatar" aria-label="AI"></div>',
  };

  let dialogReturnFocus = null;

  function copyText(text, onSuccess, onFailure) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(onSuccess).catch(() => fallbackCopy(text, onSuccess, onFailure));
    } else {
      fallbackCopy(text, onSuccess, onFailure);
    }
  }

  function fallbackCopy(text, onSuccess, onFailure) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      if (typeof onSuccess === 'function') onSuccess();
    } catch {
      if (typeof onFailure === 'function') onFailure();
    }
    document.body.removeChild(ta);
  }

  function closeCopyMenus(root) {
    root?.querySelectorAll('.copy-menu.open').forEach(menu => menu.classList.remove('open'));
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function showDialog(modal) {
    if (!modal) return;
    dialogReturnFocus = document.activeElement;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => modal.focus({ preventScroll: true }));
  }

  function hideDialog(modal) {
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    const focusTarget = dialogReturnFocus;
    dialogReturnFocus = null;
    if (focusTarget && typeof focusTarget.focus === 'function') {
      requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
    }
  }

  function openDialog(modals) {
    return (modals || []).find(modal => modal && !modal.classList.contains('hidden')) || null;
  }

  function trapDialogFocus(event, modal) {
    const focusable = Array.from(modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  window.OwnChatUiUtils = {
    copyText,
    fallbackCopy,
    closeCopyMenus,
    downloadJson,
  };
  window.OwnChatDialogs = {
    show: showDialog,
    hide: hideDialog,
    open: openDialog,
    trapFocus: trapDialogFocus,
  };
  window.OwnChatIcons = icons;
})();

// ===== Image Core =====
(function () {
  'use strict';

  const Shared = window.OwnChatImageShared;

  function imageReferenceList(refs, maxRefs = Infinity) {
    const list = Array.isArray(refs) ? refs.slice() : (refs ? [refs] : []);
    return list.filter(ref => ref?.base64).slice(0, maxRefs);
  }

  function imageReferencePayload(refs, maxRefs = Infinity) {
    return imageReferenceList(refs, maxRefs).map(ref => ({
      name: ref.name,
      type: ref.type,
      base64: ref.base64,
    }));
  }

  function imageJobReplies(job) {
    if (!job) return [];
    return Array.isArray(job.replies) ? job.replies : [];
  }

  function ensureImageJobReplies(job) {
    if (!job) return [];
    if (!Array.isArray(job.replies)) job.replies = [];
    return job.replies;
  }

  function currentImageActiveReply(job) {
    const replies = ensureImageJobReplies(job);
    return replies.find(reply => reply.status === 'generating') || replies[replies.length - 1] || null;
  }

  function imageReplyOutput(job, replyIndex, outputIndex) {
    const reply = imageJobReplies(job)[Number.isFinite(replyIndex) ? replyIndex : 0];
    return {
      reply,
      out: reply?.outputs?.[Number.isFinite(outputIndex) ? outputIndex : 0],
    };
  }

  function normalizeImageFormat(format) {
    return Shared.normalizeImageFormat(format);
  }

  function normalizeImageModel(model) {
    return Shared.normalizeImageModel(model);
  }

  function imageModelDisallowsTransparentBackground(model) {
    return Shared.imageModelDisallowsTransparentBackground(model);
  }

  function imageBackgroundSupported(model, background) {
    return Shared.imageBackgroundSupported(model, background);
  }

  function sanitizeImageParamsForModel(model, params = {}) {
    return Shared.sanitizeImageParamsForModel(model, params);
  }

  function dataUrlForImage(out, fallbackFormat) {
    if (!out) return '';
    const format = normalizeImageFormat(out.format || fallbackFormat || 'png') || 'png';
    if (out.url) {
      const sanitizeUrl = window.OwnChatMarkdown?.sanitizeUrl || (url => url);
      return sanitizeUrl(out.url, { image: true });
    }
    return `data:image/${format};base64,${out.b64 || ''}`;
  }

  function imageByteSize(out) {
    if (Number.isFinite(out?.bytes)) return out.bytes;
    if (!out?.b64) return 0;
    const clean = out.b64.replace(/\s/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
  }

  function imageOutputMeta(out, fallbackFormat) {
    const size = out?.width && out?.height ? `${out.width}x${out.height}` : '尺寸读取中';
    const format = normalizeImageFormat(out?.format || fallbackFormat || '') || '未知格式';
    const bytes = window.OwnChatAttachments?.formatBytes?.(imageByteSize(out)) || '大小未知';
    return [size, format.toUpperCase(), bytes].filter(Boolean);
  }

  function normalizeImageUsage(usage) {
    return Shared.normalizeImageUsage(usage);
  }

  function imageUsageMeta(usage) {
    const normalized = normalizeImageUsage(usage);
    if (!normalized) return [];
    const formatCount = value => window.OwnChatTokens?.formatTokenCount?.(value) || String(value);
    const primary = Number.isFinite(normalized.total)
      ? normalized.total
      : (Number.isFinite(normalized.output) ? normalized.output : normalized.input);
    if (!Number.isFinite(primary)) return [];
    const parts = [];
    if (Number.isFinite(normalized.input)) parts.push(`输入 ${formatCount(normalized.input)}`);
    if (Number.isFinite(normalized.output)) parts.push(`输出 ${formatCount(normalized.output)}`);
    if (Number.isFinite(normalized.total)) parts.push(`总计 ${formatCount(normalized.total)}`);
    return [{
      text: `Tokens ${formatCount(primary)}`,
      title: parts.join(' / '),
    }];
  }

  function imageResponseResult(outputs, usage = null) {
    return {
      outputs: Array.isArray(outputs) ? outputs : [],
      usage: normalizeImageUsage(usage),
    };
  }

  function isRenderableImageOutput(out) {
    return !!(out && !out.failed && (out.b64 || out.url));
  }

  function imageResultOutputs(result) {
    if (Array.isArray(result)) return result;
    return Array.isArray(result?.outputs) ? result.outputs : [];
  }

  function imageResultUsage(result) {
    return normalizeImageUsage(result?.usage);
  }

  function combineImageUsages(usages) {
    const normalized = (usages || []).map(normalizeImageUsage).filter(Boolean);
    if (!normalized.length) return null;
    const combined = {};
    const add = (target, key, value) => {
      if (Number.isFinite(value)) target[key] = (target[key] || 0) + value;
    };
    normalized.forEach(usage => {
      add(combined, 'input', usage.input);
      add(combined, 'output', usage.output);
      add(combined, 'total', usage.total);
      if (usage.details) {
        combined.details = combined.details || {};
        add(combined.details, 'inputImage', usage.details.inputImage);
        add(combined.details, 'inputText', usage.details.inputText);
        add(combined.details, 'outputImage', usage.details.outputImage);
        add(combined.details, 'outputText', usage.details.outputText);
      }
    });
    if (combined.details && !Object.keys(combined.details).length) delete combined.details;
    return Object.keys(combined).length ? combined : null;
  }

  function safeFileStem(value, fallback, maxLength = 60) {
    return (value || fallback).replace(/[\\/:*?"<>|]+/g, '-').slice(0, maxLength) || fallback;
  }

  function imageFilename(job, out) {
    const ext = out?.format || job?.params?.outputFormat || 'png';
    return `${safeFileStem(job?.title, 'ownchat-image')}.${ext}`;
  }

  function attachmentImageFilename(item) {
    const fallback = `attachment.${item?.format || 'png'}`;
    return safeFileStem(item?.name, fallback, 80);
  }

  function imageViewerItemsForJob(job, scope = 'outputs', maxRefs = Infinity) {
    if (!job) return [];
    const items = [];
    imageJobReplies(job).forEach((reply, replyIndex) => {
      if (scope === 'inputs') {
        imageReferencePayload(reply.inputImages || job.inputImages, maxRefs).forEach((inputImage, refIndex) => {
          const format = (inputImage.type || '').replace(/^image\//, '') || (reply.params || job.params)?.outputFormat || 'png';
          items.push({
            jobId: job.id,
            inputRef: true,
            inputImage,
            replyIndex,
            refIndex,
            src: inputImage.base64,
            out: { b64: inputImage.base64.split(',').pop(), format },
          });
        });
      }
      if (scope !== 'outputs') return;
      (reply.outputs || []).forEach((output, index) => {
        if (!isRenderableImageOutput(output)) return;
        items.push({
          jobId: job.id,
          replyIndex,
          index,
          src: dataUrlForImage(output, (reply.params || job.params)?.outputFormat),
          out: output,
        });
      });
    });
    return items;
  }

  function estimateImageSeconds(params = {}, refs = []) {
    const qualityFactor = params.quality === 'high' ? 130 : params.quality === 'medium' ? 95 : params.quality === 'low' ? 60 : 90;
    const sizeFactor = params.size === '3840x2160' || params.size === '2160x3840'
      ? 95
      : params.size === '1536x1024' || params.size === '1024x1536'
        ? 35
        : params.size === 'auto' ? 15 : 20;
    const editFactor = (Array.isArray(refs) ? refs.length > 0 : !!refs) ? 35 : 0;
    return Math.max(60, qualityFactor + sizeFactor + editFactor);
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const restSeconds = seconds % 60;
    return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  }

  function formatDateTime(ts) {
    const date = new Date(ts || Date.now());
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function imageTimeoutMs(params, refs = []) {
    return Math.max(30 * 60 * 1000, estimateImageSeconds(params, refs) * 1000 * 3);
  }

  function imageStaleTimeoutMs() {
    return 10 * 60 * 1000;
  }

  function imageJobDuration(job, activeReply, startedAt = null) {
    return Date.now() - (startedAt || activeReply?.startedAt || job?.startedAt || job?.createdAt || Date.now());
  }

  function setImageJobDone(job, activeReply, outputs, startedAt = null, usage = null) {
    const normalizedUsage = normalizeImageUsage(usage);
    activeReply.outputs = outputs;
    activeReply.usage = normalizedUsage;
    activeReply.error = null;
    activeReply.status = 'done';
    activeReply.durationMs = imageJobDuration(job, activeReply, startedAt);
    job.outputs = outputs;
    job.usage = normalizedUsage;
    job.error = null;
    job.status = 'done';
    job.durationMs = activeReply.durationMs;
  }

  function setImageJobFailed(job, activeReply, message, status = 'error', startedAt = null) {
    const isCancelled = status === 'cancelled';
    activeReply.error = message || (isCancelled ? '请求已中断' : '生成失败');
    activeReply.status = isCancelled ? 'cancelled' : 'error';
    activeReply.durationMs = imageJobDuration(job, activeReply, startedAt);
    job.error = activeReply.error;
    job.status = activeReply.status;
    job.durationMs = activeReply.durationMs;
  }

  function completeImageJobFromSession(job, activeReply, session, startedAt) {
    const nextOutputs = window.OwnChatDb?.parseImageSessionOutputs?.(session) || [];
    const successOutputs = nextOutputs.filter(isRenderableImageOutput);
    if (nextOutputs.length) {
      activeReply.outputs = nextOutputs;
      job.outputs = nextOutputs;
    }
    if (successOutputs.length === 0) {
      setImageJobFailed(job, activeReply, session?.error || '接口未返回可显示的图片数据', 'error', startedAt);
    } else {
      setImageJobDone(job, activeReply, nextOutputs, startedAt, session?.usage);
    }
  }

  function failImageJobFromSession(job, activeReply, message, status = 'error', startedAt = null) {
    setImageJobFailed(job, activeReply, message, status, startedAt);
  }

  function parseImageOutputs(data, format) {
    const outputs = (data.data || []).map(item => ({
      b64: item.b64_json || '',
      url: item.url || '',
      revisedPrompt: item.revised_prompt || '',
      format: normalizeImageFormat(item.output_format || item.mime_type || format),
      bytes: item.b64_json ? imageByteSize({ b64: item.b64_json }) : 0,
      createdAt: Date.now(),
    })).filter(item => item.b64 || item.url);
    return imageResponseResult(outputs, data.usage);
  }

  function parseResponseImageOutputs(data, format) {
    const outputs = [];
    const scan = value => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(scan);
        return;
      }
      if (typeof value !== 'object') return;
      if ((value.type === 'image_generation_call' || value.type === 'image_generation') && value.result) {
        outputs.push({
          b64: value.result,
          url: '',
          revisedPrompt: '',
          format: normalizeImageFormat(value.output_format || value.mime_type || format),
          bytes: imageByteSize({ b64: value.result }),
          createdAt: Date.now(),
        });
      }
      Object.keys(value).forEach(key => scan(value[key]));
    };
    scan(data.output || data);
    return imageResponseResult(outputs, data.usage || data.response?.usage);
  }

  function imageToolOptions(params = {}, model = '') {
    const effectiveParams = sanitizeImageParamsForModel(model, params);
    const opts = { type: 'image_generation' };
    if (effectiveParams.size !== 'auto') opts.size = effectiveParams.size;
    if (effectiveParams.quality !== 'auto') opts.quality = effectiveParams.quality;
    if (effectiveParams.outputFormat) opts.output_format = effectiveParams.outputFormat;
    if (effectiveParams.background !== 'auto') opts.background = effectiveParams.background;
    return opts;
  }

  function mappedImageInput(prompt, refs) {
    const list = imageReferenceList(refs);
    if (!list.length) return prompt.trim();
    return [{
      role: 'user',
      content: [
        { type: 'input_text', text: prompt.trim() },
        ...list.map(item => ({ type: 'input_image', image_url: item.base64 })),
      ],
    }];
  }

  function buildImageRequestBody(model, prompt, params = {}) {
    const effectiveParams = sanitizeImageParamsForModel(model, params);
    const body = {
      model,
      prompt: prompt.trim(),
      n: 1,
    };
    if (effectiveParams.size !== 'auto') body.size = effectiveParams.size;
    if (effectiveParams.quality !== 'auto') body.quality = effectiveParams.quality;
    if (effectiveParams.outputFormat && !/^dall-e/i.test(model)) body.output_format = effectiveParams.outputFormat;
    if (effectiveParams.background !== 'auto') body.background = effectiveParams.background;
    return body;
  }

  function extractChatText(data) {
    const msg = data?.choices?.[0]?.message;
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content.trim();
    if (Array.isArray(msg.content)) {
      return msg.content.map(part => part.text || '').join('').trim();
    }
    return '';
  }

  function promptLanguageInstruction(prompt) {
    const cjkCount = (prompt.match(/[\u3400-\u9fff]/g) || []).length;
    const latinCount = (prompt.match(/[a-zA-Z]/g) || []).length;
    if (cjkCount > 0 && cjkCount >= latinCount * 0.3) {
      return {
        label: '中文',
        instruction: '用户原提示词主要是中文，优化结果必须使用中文输出。不要翻译成英文，不要中英混写，除非原文中的品牌名、专有名词或参数本身是英文。',
      };
    }
    return {
      label: '原文语言',
      instruction: '优化结果必须使用用户原提示词的主要语言输出。不要擅自切换语言；只有原文是英文时才输出英文。',
    };
  }

  function dataUrlToBlob(dataUrl) {
    return Shared.dataUrlToBlob(dataUrl);
  }

  function blobToDataUrl(blob) {
    return Shared.blobToDataUrl(blob);
  }

  function filenameForBlob(name, blob) {
    const ext = blob.type.includes('jpeg') ? 'jpg' : blob.type.includes('webp') ? 'webp' : 'png';
    const base = (name || 'reference').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60);
    return `${base || 'reference'}.${ext}`;
  }

  function createImageReply({ jobId, prompt, params, refs, startedAt, model, mapModel, replyId = `${jobId}-reply-${Date.now()}` }) {
    const inputImages = imageReferencePayload(refs);
    return {
      id: replyId,
      model,
      mapModel,
      prompt: prompt.trim(),
      inputImages,
      params: Object.assign({}, params),
      outputs: [],
      error: null,
      status: 'generating',
      startedAt,
      createdAt: startedAt,
      estimatedSeconds: estimateImageSeconds(params, inputImages),
      durationMs: null,
      usage: null,
    };
  }

  window.OwnChatImageCore = {
    imageReferenceList,
    imageReferencePayload,
    imageJobReplies,
    ensureImageJobReplies,
    currentImageActiveReply,
    imageReplyOutput,
    dataUrlForImage,
    imageByteSize,
    isRenderableImageOutput,
    normalizeImageFormat,
    normalizeImageModel,
    imageModelDisallowsTransparentBackground,
    imageBackgroundSupported,
    sanitizeImageParamsForModel,
    imageOutputMeta,
    normalizeImageUsage,
    imageUsageMeta,
    imageResponseResult,
    imageResultOutputs,
    imageResultUsage,
    combineImageUsages,
    imageFilename,
    attachmentImageFilename,
    imageViewerItemsForJob,
    estimateImageSeconds,
    formatDuration,
    formatDateTime,
    imageTimeoutMs,
    imageStaleTimeoutMs,
    imageJobDuration,
    setImageJobDone,
    setImageJobFailed,
    completeImageJobFromSession,
    failImageJobFromSession,
    parseImageOutputs,
    parseResponseImageOutputs,
    imageToolOptions,
    mappedImageInput,
    buildImageRequestBody,
    extractChatText,
    promptLanguageInstruction,
    dataUrlToBlob,
    blobToDataUrl,
    filenameForBlob,
    createImageReply,
  };
})();

// ===== Image API Client =====
(function () {
  'use strict';

  const Api = window.OwnChatApi;
  const ImageCore = window.OwnChatImageCore;

  function authHeaders(apiKey) {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
  }

  async function parseError(resp) {
    return resp.json().catch(() => ({ error: { message: `HTTP ${resp.status}` } }));
  }

  async function requestMappedImage(endpoint, prompt, params, refs = [], signal = null) {
    const url = Api.requestUrl(endpoint.baseUrl, '/responses');
    const body = buildMappedImageBody(endpoint.model, prompt, params, refs);
    const resp = await Api.apiFetch(url, {
      method: 'POST',
      headers: authHeaders(endpoint.apiKey),
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const err = await parseError(resp);
      throw Api.httpError(resp.status, err.error?.message || `HTTP ${resp.status}`, url);
    }
    return ImageCore.parseResponseImageOutputs(await resp.json(), params.outputFormat);
  }

  async function optimizePrompt(endpoint, prompt, signal = null) {
    const lang = ImageCore.promptLanguageInstruction(prompt);
    const url = Api.requestUrl(endpoint.baseUrl, '/chat/completions');
    const resp = await Api.apiFetch(url, {
      method: 'POST',
      headers: authHeaders(endpoint.apiKey),
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0.4,
        messages: [
          {
            role: 'system',
            content: `你是专业图像生成提示词编辑器。把用户需求优化成更适合图像生成模型的提示词。${lang.instruction}只输出优化后的提示词，不要解释，不要使用 Markdown。保留用户核心意图，补充主体、构图、风格、光线、色彩、细节、画面质量。不要加入违反安全或版权的内容。`,
          },
          {
            role: 'user',
            content: `请优化下面的绘画提示词。\n输出语言要求：${lang.label}。\n如果原文是中文，结果必须是中文。\n\n原提示词：\n${prompt}`,
          },
        ],
      }),
      signal,
    });
    if (!resp.ok) {
      const err = await parseError(resp);
      throw Api.httpError(resp.status, err.error?.message || `HTTP ${resp.status}`, url);
    }
    return ImageCore.extractChatText(await resp.json()).replace(/^["“]|["”]$/g, '').trim();
  }

  async function requestOneImage(endpoint, model, prompt, params, signal = null) {
    const url = Api.requestUrl(endpoint.baseUrl, '/images/generations');
    const body = ImageCore.buildImageRequestBody(model, prompt, params);
    const resp = await Api.apiFetch(url, {
      method: 'POST',
      headers: authHeaders(endpoint.apiKey),
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const err = await parseError(resp);
      throw Api.httpError(resp.status, err.error?.message || `HTTP ${resp.status}`, url);
    }
    return ImageCore.parseImageOutputs(await resp.json(), params.outputFormat);
  }

  async function requestImageEdit(endpoint, model, prompt, params, refs = [], signal = null) {
    const url = Api.requestUrl(endpoint.baseUrl, '/images/edits');
    const form = buildImageEditForm(model, prompt, params, refs);
    const resp = await Api.apiFetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${endpoint.apiKey}` },
      body: form,
      signal,
    });
    if (!resp.ok) {
      const err = await parseError(resp);
      throw Api.httpError(resp.status, err.error?.message || `HTTP ${resp.status}`, url);
    }
    return ImageCore.parseImageOutputs(await resp.json(), params.outputFormat);
  }

  function buildMappedImageBody(model, prompt, params, refs = []) {
    return {
      model,
      input: ImageCore.mappedImageInput(prompt, refs),
      tools: [ImageCore.imageToolOptions(params, model)],
      tool_choice: 'required',
    };
  }

  function buildImageEditForm(model, prompt, params, refs = []) {
    const effectiveParams = ImageCore.sanitizeImageParamsForModel(model, params);
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt.trim());
    form.append('n', '1');
    ImageCore.imageReferenceList(refs).forEach(item => {
      const refBlob = ImageCore.dataUrlToBlob(item.base64);
      if (!refBlob.size) return;
      form.append('image', refBlob, ImageCore.filenameForBlob(item.name, refBlob));
    });
    if (effectiveParams.size !== 'auto') form.append('size', effectiveParams.size);
    if (effectiveParams.quality !== 'auto') form.append('quality', effectiveParams.quality);
    if (effectiveParams.outputFormat && !/^dall-e/i.test(model)) form.append('output_format', effectiveParams.outputFormat);
    if (effectiveParams.background !== 'auto') form.append('background', effectiveParams.background);
    return form;
  }

  function buildServiceWorkerRequest({ imageEndpoint, mapEndpoint = null, model, mapModel, prompt, params, refs = [], jobId, startedAt, timeoutMs }) {
    const requestModel = mapModel && mapEndpoint ? mapEndpoint.model : model;
    const effectiveParams = ImageCore.sanitizeImageParamsForModel(requestModel, params);
    const headers = authHeaders(imageEndpoint.apiKey);
    const base = {
      type: 'start-image',
      jobId,
      startedAt,
      timeoutMs,
      outputFormat: effectiveParams.outputFormat,
      count: effectiveParams.count || 1,
      maxParallel: 5,
    };

    if (mapModel && mapEndpoint) {
      return Object.assign(base, {
        url: Api.requestUrl(mapEndpoint.baseUrl, '/responses'),
        headers: authHeaders(mapEndpoint.apiKey),
        body: JSON.stringify(buildMappedImageBody(mapEndpoint.model, prompt, effectiveParams, refs)),
        requestType: 'responses',
      });
    }

    if (refs.length) {
      return Object.assign(base, {
        url: Api.requestUrl(imageEndpoint.baseUrl, '/images/edits'),
        headers,
        requestType: 'edit',
        formParams: {
          model,
          prompt: prompt.trim(),
          images: refs.map(item => ({ base64: item.base64, filename: item.name })),
          size: effectiveParams.size,
          quality: effectiveParams.quality,
          outputFormat: effectiveParams.outputFormat,
          background: effectiveParams.background,
        },
      });
    }

    return Object.assign(base, {
      url: Api.requestUrl(imageEndpoint.baseUrl, '/images/generations'),
      headers,
      body: JSON.stringify(ImageCore.buildImageRequestBody(model, prompt, effectiveParams)),
      requestType: 'generations',
    });
  }

  window.OwnChatImageApi = {
    requestMappedImage,
    optimizePrompt,
    requestOneImage,
    requestImageEdit,
    buildServiceWorkerRequest,
  };
})();

// ===== Image Renderer =====
(function () {
  'use strict';

  const ImageCore = window.OwnChatImageCore;
  const Tokens = window.OwnChatTokens;
  const Markdown = window.OwnChatMarkdown;

  function esc(value) {
    return Markdown.esc(value);
  }

  function renderWorkspace(selectedJob, options = {}) {
    if (options.isLoading) {
      return {
        hasSelected: false,
        html: `
          <div class="image-history-loading" role="status" aria-live="polite">
            <div class="image-spinner"></div>
            <span>正在加载绘画历史...</span>
          </div>
        `,
      };
    }
    return {
      hasSelected: !!selectedJob,
      html: selectedJob ? renderImageJob(selectedJob, options) : '',
    };
  }

  function renderImageJob(job, options = {}) {
    const defaultParams = options.defaultParams || {};
    const userMessage = renderUserMessage(job, job.prompt, job.inputImages, job.createdAt, job.params || defaultParams, '', options);
    const replies = ImageCore.imageJobReplies(job);
    const replyMessages = replies.map((reply, replyIndex) => renderReplyMessage(job, reply, replyIndex, options)).join('');
    const progressMessage = renderProgressMessage(job, options);

    return `
      <article class="image-job-card" data-id="${esc(job.id)}">
        ${userMessage}
        ${replyMessages}
        ${progressMessage}
      </article>
    `;
  }

  function renderUserMessage(job, prompt, inputImages, createdAt, params, replyIndex, options = {}) {
    const icons = options.icons || {};
    const refs = ImageCore.imageReferencePayload(inputImages, options.maxRefs);
    const inputRef = refs.length
      ? `<div class="image-input-ref-list">
          ${refs.map((inputImage, refIndex) => `
            <div class="image-input-ref">
              <img src="${esc(inputImage.base64)}" alt="${esc(inputImage.name || '参考图')}" class="image-input-preview" data-job="${esc(job.id)}" data-reply="${esc(String(replyIndex))}" data-ref="${refIndex}">
              <span>${esc(inputImage.name || `参考图 ${refIndex + 1}`)}</span>
            </div>
          `).join('')}
        </div>`
      : '';

    return `
      <div class="image-chat-msg user">
        <div class="image-chat-inner">
          <div class="image-chat-avatar">${icons.person || ''}</div>
          <div class="image-chat-bubble image-chat-bubble-prompt">
            <div class="image-chat-prompt">${esc(prompt || '')}</div>
            ${inputRef}
            <div class="image-msg-meta">
              <span>${ImageCore.formatDateTime(createdAt || job.createdAt)}</span>
              <span>~${Tokens.formatTokenCount(Tokens.estimateTokens(prompt))} tokens</span>
              <button class="msg-action-btn image-action" data-action="copy-prompt" data-job="${esc(job.id)}" data-prompt="${esc(prompt || '')}" type="button" title="复制提示词" data-tooltip="复制提示词">${icons.copy || ''}</button>
              <button class="msg-action-btn image-action" data-action="reuse" data-job="${esc(job.id)}" data-prompt="${esc(prompt || '')}" data-size="${esc(params.size || '')}" data-quality="${esc(params.quality || '')}" data-count="${esc(params.count || 1)}" data-format="${esc(params.outputFormat || '')}" data-background="${esc(params.background || '')}" type="button" title="复用到输入框" data-tooltip="复用到输入框">${icons.edit || ''}</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderReplyMessage(job, reply, replyIndex, options = {}) {
    const defaultParams = options.defaultParams || {};
    const params = reply.params || job.params || defaultParams;
    const progressInfo = imageProgressInfo(job, reply);
    const replyUserMessage = replyIndex > 0
      ? renderUserMessage(job, reply.prompt || job.prompt, reply.inputImages || null, reply.createdAt || reply.startedAt, params, replyIndex, options)
      : '';

    if (reply.status === 'generating' && !(reply.outputs || []).length && !reply.error) {
      return replyUserMessage;
    }

    const aiMetaParts = [
      metaText(reply.model || job.model),
      metaText(reply.mapModel && options.formatSourcedModel ? `映射 ${options.formatSourcedModel(reply.mapModel)}` : ''),
      metaText(reply.durationMs ? `耗时 ${ImageCore.formatDuration(reply.durationMs)}` : ''),
      metaText((reply.progress || job.progress || progressInfo.total > 1) ? progressSummaryText(progressInfo) : ''),
      ...ImageCore.imageUsageMeta(reply.usage || job.usage).map(metaText),
      metaText(ImageCore.formatDateTime(reply.durationMs ? (reply.startedAt || reply.createdAt || job.createdAt) + reply.durationMs : (reply.createdAt || job.createdAt))),
    ].filter(Boolean).join('');

    const outputList = (reply.outputs || []).slice(0, progressInfo.total);
    const outputs = outputList.map((out, index) => renderOutput(job, reply, replyIndex, out, index, options)).join('');
    const resultsClass = `image-results${outputList.length > 1 ? ' image-results-gallery' : ''}`;
    const inlineProgress = reply.status === 'generating' ? renderProgressBlock(job, options, { inline: true }) : '';
    const jobActions = reply.status === 'generating' ? '' : `
            <div class="image-job-actions">
              <button class="btn-secondary image-action" data-action="edit-latest" data-job="${esc(job.id)}" data-reply="${replyIndex}" type="button">编辑</button>
              <button class="btn-secondary image-action" data-action="retry" data-job="${esc(job.id)}" data-reply="${replyIndex}" type="button">重绘</button>
            </div>`;

    return `
      ${replyUserMessage}
      <div class="image-chat-msg ai">
        <div class="image-chat-inner">
          <div class="image-chat-avatar image-ai-avatar" aria-label="AI"></div>
          <div class="image-chat-bubble image-chat-bubble-result">
            ${reply.error ? `<div class="image-error">${esc(reply.error)}</div>` : ''}
            <div class="${resultsClass}">${outputs}</div>
            ${inlineProgress}
            <div class="image-msg-meta">${aiMetaParts}</div>
            ${jobActions}
          </div>
        </div>
      </div>
    `;
  }

  function renderOutput(job, reply, replyIndex, out, index, options = {}) {
    const icons = options.icons || {};
    const params = reply.params || job.params || options.defaultParams || {};
    if (out?.failed) {
      const message = out.error || '这张图片生成失败';
      if (out.retrying) {
        return `
      <div class="image-result image-result-failed image-result-retrying" data-job="${esc(job.id)}" data-reply="${replyIndex}" data-index="${index}">
        <div class="image-failed-body">
          <div class="image-spinner"></div>
          <div class="image-failed-title">正在重试第 ${index + 1} 张</div>
          <div class="image-failed-text">成功后会直接替换这张失败卡片。</div>
        </div>
        <div class="image-result-meta image-result-meta-failed">重试中</div>
      </div>
    `;
      }
      return `
      <div class="image-result image-result-failed" data-job="${esc(job.id)}" data-reply="${replyIndex}" data-index="${index}">
        <div class="image-failed-body">
          <div class="image-failed-mark">!</div>
          <div class="image-failed-title">第 ${index + 1} 张生成失败</div>
          <div class="image-failed-text">${esc(message)}</div>
        </div>
        <div class="image-result-meta image-result-meta-failed">失败</div>
        <div class="image-result-actions image-result-actions-visible">
          <button class="msg-action-btn image-action" data-action="retry-failed-image" data-job="${esc(job.id)}" data-reply="${replyIndex}" data-index="${index}" title="重试这张" data-tooltip="重试这张">${icons.refresh || '重试'}</button>
        </div>
      </div>
    `;
    }
    const outputMeta = ImageCore.imageOutputMeta(out, params.outputFormat).map(esc).join('<span>·</span>');
    return `
      <div class="image-result" data-job="${esc(job.id)}" data-reply="${replyIndex}" data-index="${index}">
        <img src="${esc(ImageCore.dataUrlForImage(out, params.outputFormat))}" alt="${esc(job.prompt)}" loading="eager" decoding="async" class="image-preview">
        <div class="image-result-meta">${outputMeta}</div>
        <div class="image-result-actions">
          <button class="msg-action-btn image-action" data-action="view" data-job="${esc(job.id)}" data-reply="${replyIndex}" data-index="${index}" title="放大查看" data-tooltip="放大查看">${icons.maximize || ''}</button>
          <button class="msg-action-btn image-action" data-action="use-as-ref" data-job="${esc(job.id)}" data-reply="${replyIndex}" data-index="${index}" title="以图编辑" data-tooltip="以图编辑">${icons.edit || ''}</button>
          <button class="msg-action-btn image-action" data-action="copy-image" data-job="${esc(job.id)}" data-reply="${replyIndex}" data-index="${index}" title="复制图片" data-tooltip="复制图片">${icons.copy || ''}</button>
          <button class="msg-action-btn image-action" data-action="download" data-job="${esc(job.id)}" data-reply="${replyIndex}" data-index="${index}" title="下载" data-tooltip="下载">${icons.download || ''}</button>
        </div>
      </div>
    `;
  }

  function metaText(item) {
    if (!item) return '';
    const meta = typeof item === 'object' ? item : { text: item };
    const tooltip = meta.title && meta.title !== meta.text ? ` data-tooltip="${esc(meta.title)}"` : '';
    return `<span${tooltip}><span class="image-meta-label">${esc(meta.text)}</span></span>`;
  }

  function renderProgressMessage(job, options = {}) {
    if (job.status !== 'generating') return '';
    const activeReply = ImageCore.currentImageActiveReply(job);
    if ((activeReply?.outputs || []).length) return '';
    const progress = renderProgressBlock(job, options);

    return `
      <div class="image-chat-msg ai">
        <div class="image-chat-inner">
          <div class="image-chat-avatar image-ai-avatar" aria-label="AI"></div>
          <div class="image-chat-bubble image-chat-bubble-progress">${progress}</div>
        </div>
      </div>
    `;
  }

  function renderProgressBlock(job, options = {}, opts = {}) {
    const now = options.now || Date.now();
    const waitedMs = now - (job.startedAt || job.createdAt);
    const progress = imageProgressInfo(job);
    const count = progress.total;
    const pending = Math.max(0, progress.total - progress.completed);
    const title = count > 1 ? `生成队列运行中：${progress.completed}/${progress.total}` : '正在生成图片';
    const note = count > 1
      ? `成功一张会立即显示，失败会保留可重试卡片；剩余 ${pending} 张。`
      : '正在生成，请勿关闭页面。';
    return `<div class="image-progress${opts.inline ? ' image-progress-inline' : ''}" data-job="${esc(job.id)}">
      <div class="image-progress-indicator">
        <div class="image-spinner"></div>
      </div>
      <div class="image-progress-body">
        <div class="image-progress-title">${esc(title)}</div>
        <div class="image-progress-stats">
          <span class="image-progress-elapsed">耗时 ${ImageCore.formatDuration(waitedMs)}</span>
          <span>完成 ${progress.completed}/${progress.total}</span>
          <span>成功 ${progress.success}</span>
          ${progress.failed ? `<span class="image-progress-failed">失败 ${progress.failed}</span>` : ''}
          ${count > 1 ? `<span>待完成 ${pending}</span>` : ''}
          ${progress.maxParallel > 1 ? `<span>并发 ${progress.maxParallel}</span>` : ''}
        </div>
        <div class="image-progress-note">${esc(note)}</div>
      </div>
      <button class="btn-secondary image-action image-cancel-btn" data-action="cancel" data-job="${esc(job.id)}" type="button">取消</button>
    </div>`;
  }

  function imageProgressInfo(job, reply = null) {
    const activeReply = reply || ImageCore.currentImageActiveReply(job) || {};
    const progress = activeReply.progress || job.progress || {};
    const total = Math.max(1, Number(progress.total) || Number(activeReply.params?.count) || Number(job.params?.count) || 1);
    const outputCount = (activeReply.outputs || []).filter(ImageCore.isRenderableImageOutput).length;
    const failedOutputCount = (activeReply.outputs || []).filter(out => out?.failed).length;
    const success = Math.max(0, Number.isFinite(Number(progress.success)) ? Number(progress.success) : outputCount);
    const failed = Math.max(0, Number.isFinite(Number(progress.failed)) ? Number(progress.failed) : failedOutputCount);
    const completed = Math.min(total, Math.max(success + failed, Number(progress.completed) || 0));
    const maxParallel = Math.max(1, Number(progress.maxParallel) || 1);
    return { total, completed, success, failed, maxParallel };
  }

  function progressSummaryText(progress) {
    const failed = progress.failed ? `，失败 ${progress.failed}` : '';
    return `完成 ${progress.completed}/${progress.total}，成功 ${progress.success}${failed}`;
  }

  window.OwnChatImageRenderer = {
    renderWorkspace,
    renderImageJob,
    renderUserMessage,
    renderReplyMessage,
    renderOutput,
    renderProgressMessage,
  };
})();

// ===== Image Viewer =====
(function () {
  'use strict';

  let dom = null;
  let callbacks = {};
  let mounted = false;
  let viewer = null;
  let transform = { scale: 1, x: 0, y: 0 };
  let dragging = null;
  let touch = null;

  function mount(elements, opts = {}) {
    dom = elements;
    callbacks = opts || {};
    if (mounted) return;
    mounted = true;

    dom.closeBtn?.addEventListener('pointerdown', stopControlPointer);
    dom.prevBtn?.addEventListener('pointerdown', stopControlPointer);
    dom.nextBtn?.addEventListener('pointerdown', stopControlPointer);
    dom.closeBtn?.addEventListener('click', activateClose);
    dom.backdrop?.addEventListener('click', close);
    dom.prevBtn?.addEventListener('click', (e) => activateSwitch(e, -1));
    dom.nextBtn?.addEventListener('click', (e) => activateSwitch(e, 1));
    dom.zoomOutBtn?.addEventListener('click', () => zoomBy(1 / 1.18));
    dom.zoomInBtn?.addEventListener('click', () => zoomBy(1.18));
    dom.zoomResetBtn?.addEventListener('click', resetTransform);
    dom.img?.addEventListener('wheel', zoom, { passive: false });
    dom.img?.addEventListener('pointerdown', startDrag);
    dom.viewer?.addEventListener('pointermove', moveDrag);
    dom.viewer?.addEventListener('pointerup', endDrag);
    dom.viewer?.addEventListener('pointercancel', endDrag);
    dom.img?.addEventListener('dblclick', toggleZoom);
    dom.img?.addEventListener('touchstart', startTouch, { passive: false });
    dom.img?.addEventListener('touchmove', moveTouch, { passive: false });
    dom.img?.addEventListener('touchend', endTouch);
    dom.img?.addEventListener('touchcancel', endTouch);
    dom.copyBtn?.addEventListener('click', () => callbacks.onCopy?.(current()));
    dom.downloadBtn?.addEventListener('click', () => callbacks.onDownload?.(current()));
    document.addEventListener('keydown', handleKeydown);
  }

  function activateClose(e) {
    e?.preventDefault();
    e?.stopPropagation();
    close();
  }

  function activateSwitch(e, direction) {
    e?.preventDefault();
    e?.stopPropagation();
    clearInteractionState();
    switchImage(direction);
  }

  function stopControlPointer(e) {
    e?.stopPropagation();
  }

  function clearInteractionState() {
    if (dragging?.pointerId != null) {
      try {
        dom?.img?.releasePointerCapture?.(dragging.pointerId);
      } catch {}
    }
    dragging = null;
    touch = null;
    dom?.viewer?.classList.remove('is-panning');
  }

  function openItems(items, itemIndex = 0) {
    viewer = {
      items: Array.isArray(items) ? items : [],
      itemIndex: Math.max(0, itemIndex),
    };
    resetTransform();
    sync();
    dom.viewer.classList.remove('hidden');
  }

  function openAttachment(item) {
    viewer = Object.assign({ attachment: true }, item);
    resetTransform();
    sync();
    dom.viewer.classList.remove('hidden');
  }

  function close() {
    clearInteractionState();
    resetTransform();
    dom.viewer.classList.add('hidden');
    dom.img.src = '';
    viewer = null;
    dom.counter.textContent = '';
    dom.counter.classList.add('hidden');
    dom.prevBtn.classList.add('hidden');
    dom.nextBtn.classList.add('hidden');
  }

  function isOpen() {
    return !!dom?.viewer && !dom.viewer.classList.contains('hidden');
  }

  function current() {
    if (!viewer) return null;
    if (viewer.attachment) return viewer;
    if (!Array.isArray(viewer.items)) return null;
    return viewer.items[viewer.itemIndex || 0] || null;
  }

  function sync() {
    if (!viewer) return;
    if (viewer.attachment) {
      dom.img.src = viewer.src;
      dom.counter.textContent = '';
      dom.counter.classList.add('hidden');
      dom.prevBtn.classList.add('hidden');
      dom.nextBtn.classList.add('hidden');
      return;
    }
    if (!Array.isArray(viewer.items)) return;
    const total = viewer.items.length;
    const itemIndex = Math.min(Math.max(viewer.itemIndex || 0, 0), Math.max(total - 1, 0));
    viewer.itemIndex = itemIndex;
    const item = viewer.items[itemIndex];
    if (item) dom.img.src = item.src;
    dom.counter.textContent = total > 1 ? `${itemIndex + 1} / ${total}` : '';
    dom.counter.classList.toggle('hidden', total <= 1);
    dom.prevBtn.classList.toggle('hidden', total <= 1);
    dom.nextBtn.classList.toggle('hidden', total <= 1);
  }

  function switchImage(direction) {
    if (!viewer || !Array.isArray(viewer.items) || viewer.items.length <= 1) return;
    const total = viewer.items.length;
    viewer.itemIndex = (viewer.itemIndex + direction + total) % total;
    clearInteractionState();
    resetTransform();
    sync();
  }

  function clampScale(scale) {
    return Math.min(8, Math.max(0.25, scale));
  }

  function applyTransform() {
    const t = transform;
    dom.img.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
    dom.img.classList.toggle('is-zoomed', t.scale > 1.01);
  }

  function resetTransform() {
    transform = { scale: 1, x: 0, y: 0 };
    clearInteractionState();
    applyTransform();
  }

  function zoomTo(nextScale, origin = null) {
    nextScale = clampScale(nextScale);
    if (Math.abs(nextScale - transform.scale) < 0.001) return;
    const rect = dom.img.getBoundingClientRect();
    const cx = origin ? origin.x - (rect.left + rect.width / 2) : 0;
    const cy = origin ? origin.y - (rect.top + rect.height / 2) : 0;
    const ratio = nextScale / transform.scale;
    transform = {
      scale: nextScale,
      x: transform.x - cx * (ratio - 1),
      y: transform.y - cy * (ratio - 1),
    };
    applyTransform();
  }

  function zoomBy(factor) {
    if (!isOpen()) return;
    zoomTo(transform.scale * factor);
  }

  function toggleZoom(e) {
    if (!isOpen()) return;
    if (transform.scale > 1.01) resetTransform();
    else zoomTo(2, e ? { x: e.clientX, y: e.clientY } : null);
  }

  function zoom(e) {
    if (!isOpen()) return;
    e.preventDefault();
    zoomTo(transform.scale * (e.deltaY < 0 ? 1.16 : 1 / 1.16), { x: e.clientX, y: e.clientY });
  }

  function startDrag(e) {
    if (!isOpen()) return;
    if (e.button !== 0 || transform.scale <= 1.01) return;
    e.preventDefault();
    dragging = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: transform.x,
      originY: transform.y,
    };
    dom.img.setPointerCapture?.(e.pointerId);
    dom.viewer.classList.add('is-panning');
  }

  function moveDrag(e) {
    if (!dragging || dragging.pointerId !== e.pointerId) return;
    e.preventDefault();
    transform.x = dragging.originX + e.clientX - dragging.startX;
    transform.y = dragging.originY + e.clientY - dragging.startY;
    applyTransform();
  }

  function endDrag(e) {
    if (!dragging || dragging.pointerId !== e.pointerId) return;
    e.preventDefault();
    dragging = null;
    dom.img.releasePointerCapture?.(e.pointerId);
    dom.viewer.classList.remove('is-panning');
  }

  function touchDistance(touches) {
    const [a, b] = touches;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function touchCenter(touches) {
    const [a, b] = touches;
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  function startTouch(e) {
    if (!isOpen() || e.touches.length !== 2) return;
    e.preventDefault();
    touch = {
      distance: touchDistance(e.touches),
      center: touchCenter(e.touches),
      scale: transform.scale,
      x: transform.x,
      y: transform.y,
    };
  }

  function moveTouch(e) {
    if (!touch || e.touches.length !== 2) return;
    e.preventDefault();
    const center = touchCenter(e.touches);
    transform = {
      scale: clampScale(touch.scale * (touchDistance(e.touches) / touch.distance)),
      x: touch.x + center.x - touch.center.x,
      y: touch.y + center.y - touch.center.y,
    };
    applyTransform();
  }

  function endTouch(e) {
    if (e.touches.length < 2) touch = null;
  }

  function handleKeydown(e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      switchImage(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      switchImage(1);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomBy(1.18);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomBy(1 / 1.18);
    } else if (e.key === '0') {
      e.preventDefault();
      resetTransform();
    }
  }

  window.OwnChatImageViewer = {
    mount,
    openItems,
    openAttachment,
    close,
    current,
    switchImage,
    resetTransform,
    zoomBy,
    isOpen,
  };
})();

// ===== Chat Renderer =====
(function () {
  'use strict';

  const Markdown = window.OwnChatMarkdown;
  const Tokens = window.OwnChatTokens;
  const Attachments = window.OwnChatAttachments;
  const Stream = window.OwnChatStream;

  function esc(value) {
    return Markdown.esc(value);
  }

  function messageTextContent(msg) {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content.filter(part => part.type === 'text').map(part => part.text || '').join('\n\n');
    }
    return '';
  }

  function copyableMessageText(msg) {
    const text = messageTextContent(msg);
    if (msg?.role !== 'assistant') return text;
    return Markdown.splitThinkTags(text).content.trim();
  }

  function copyableMessagePlainText(msg) {
    const text = copyableMessageText(msg);
    if (!text) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = Markdown.renderMd(text);
    tmp.querySelectorAll('.code-header, .code-copy-btn').forEach(el => el.remove());
    tmp.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
    tmp.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, tr').forEach(el => {
      el.appendChild(document.createTextNode('\n'));
    });
    tmp.querySelectorAll('table, ul, ol, .code-block').forEach(el => {
      el.appendChild(document.createTextNode('\n'));
    });
    return tmp.textContent
      .replace(/\u2713/g, '✓ ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function formatShortDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
  }

  function renderMessages(conv, options = {}) {
    const messages = Array.isArray(conv?.messages) ? conv.messages : [];
    const showThinking = options.showThinking !== false;
    return messages.map((msg, index) => renderMessage(msg, index, showThinking, options)).join('');
  }

  function renderMessage(msg, index, showThinking, options = {}) {
    const isUser = msg.role === 'user';
    const icons = options.icons || {};
    const avatar = isUser ? (icons.person || '') : (icons.aiAvatar || '');
    const splitContent = !isUser && typeof msg.content === 'string' ? Markdown.splitThinkTags(msg.content) : null;
    const reasoningText = showThinking && !isUser ? (msg.reasoningContent || splitContent?.reasoning || '') : '';
    const mainContent = splitContent?.reasoning ? splitContent.content : msg.content;
    const contentHtml = isUser
      ? renderUserContent(msg)
      : renderAssistantContent(msg, mainContent, reasoningText);
    const metaRow = renderMessageMeta(msg, index, isUser, icons);

    return `
      <div class="chat-msg ${isUser ? 'user' : 'ai'}">
        <div class="chat-msg-inner">
          <div class="chat-msg-avatar">${avatar}</div>
          <div class="chat-msg-body">${contentHtml}${metaRow}</div>
        </div>
      </div>
    `;
  }

  function renderUserContent(msg) {
    if (typeof msg.content === 'string') return esc(msg.content).replace(/\n/g, '<br>');
    if (!Array.isArray(msg.content)) return '';

    let contentHtml = '';
    const textPart = msg.content.find(part => part.type === 'text')?.text || '';
    if (textPart) contentHtml += esc(textPart).replace(/\n/g, '<br>');

    const imgParts = msg.content.filter(part => part.type === 'image_url');
    if (imgParts.length) {
      const fileMeta = Array.isArray(msg.files) ? msg.files.filter(file => file.base64 || file.fileId) : [];
      contentHtml += `<div class="msg-images">${imgParts.map((part, imgIdx) => {
        const file = fileMeta[imgIdx] || {};
        const name = file.name || `attachment-${imgIdx + 1}`;
        if (part.image_url?.missing || file.missing) {
          return `<div class="msg-img-missing" title="${esc(name)}">附件已丢失</div>`;
        }
        return `<img src="${esc(part.image_url?.url || '')}" class="msg-img" loading="lazy" data-action="view-attachment-image" data-name="${esc(name)}" alt="${esc(name)}">`;
      }).join('')}</div>`;
    }

    return contentHtml + renderMessageFileAttachments(msg);
  }

  function renderAssistantContent(msg, mainContent, reasoningText) {
    let contentHtml = '';
    if (reasoningText) {
      const thinkingTimeStr = msg.reasoningTimeMs != null ? formatShortDuration(msg.reasoningTimeMs) : '';
      contentHtml += `
        <div class="thinking-block">
          <button class="thinking-toggle" type="button">
            <svg class="thinking-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            <span>思考过程</span>${thinkingTimeStr ? ` · ${thinkingTimeStr}` : ''}
          </button>
          <div class="thinking-content"><div class="msg-md">${Markdown.renderMd(reasoningText)}</div></div>
        </div>
      `;
    }

    const mainText = typeof mainContent === 'string' ? mainContent : '';
    if (msg.streaming && !mainText.trim() && !reasoningText) {
      contentHtml += `
        <div class="stream-waiting">
          <div class="typing-dots"><span></span><span></span><span></span></div>
        </div>
      `;
    }
    contentHtml += `<div class="msg-md">${Markdown.renderMd(mainText)}</div>`;
    return contentHtml;
  }

  function renderMessageMeta(msg, index, isUser, icons = {}) {
    const metaParts = [];
    if (isUser && msg.timestamp) {
      metaParts.push(`<span class="msg-meta-item">${formatDateTime(msg.timestamp)}</span>`);
    }
    if (isUser && msg.includeContext === false) {
      metaParts.push('<span class="msg-meta-item">未带上文</span>');
    }
    if (!isUser && msg.firstTokenMs !== undefined) {
      metaParts.push(`<span class="msg-meta-item">首字 ${formatShortDuration(msg.firstTokenMs)}</span>`);
    }
    if (!isUser && msg.outputTimeMs != null) {
      metaParts.push(`<span class="msg-meta-item">输出 ${formatShortDuration(msg.outputTimeMs)}</span>`);
    }

    const usage = Stream.normalizeUsage(msg.usage);
    if (usage && !isUser) {
      const usageParts = [];
      if (usage.input != null) usageParts.push(`输入 ${Tokens.formatTokenCount(usage.input)}`);
      if (usage.output != null) usageParts.push(`输出 ${Tokens.formatTokenCount(usage.output)}`);
      if (usage.total != null) usageParts.push(`总计 ${Tokens.formatTokenCount(usage.total)}`);
      if (usageParts.length) metaParts.push(`<span class="msg-meta-item">${usageParts.join(' / ')}</span>`);
    } else if (msg.tokens) {
      metaParts.push(`<span class="msg-meta-item">~${Tokens.formatTokenCount(msg.tokens)} tokens</span>`);
    }
    if (!isUser && msg.model) metaParts.push(`<span class="msg-meta-item msg-model-tag">${esc(msg.model)}</span>`);

    metaParts.push(`
      <span class="copy-menu">
        <button class="msg-action-btn" data-action="copy-menu" data-idx="${index}" title="复制" data-tooltip="复制">${icons.copy || ''}</button>
        <span class="copy-menu-popover">
          <button type="button" data-action="copy-md" data-idx="${index}">复制 Markdown</button>
          <button type="button" data-action="copy-text" data-idx="${index}">复制纯文本</button>
        </span>
      </span>
    `);
    if (isUser) metaParts.push(`<button class="msg-action-btn" data-action="edit" data-idx="${index}" title="继续提问" data-tooltip="继续提问">${icons.edit || ''}</button>`);
    if (!isUser) metaParts.push(`<button class="msg-action-btn" data-action="retry" data-idx="${index}" title="重新生成，会替换这条回复之后的内容" data-tooltip="重新生成，会替换后续内容">${icons.refresh || ''}</button>`);

    return metaParts.length ? `<div class="msg-meta">${metaParts.join('')}</div>` : '';
  }

  function formatDateTime(ts) {
    const date = new Date(ts);
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function renderMessageFileIcon() {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  }

  function renderMessageFileAttachments(msg) {
    const files = Array.isArray(msg?.files) ? msg.files : [];
    const docFiles = files.filter(file => file && !(file.type || '').startsWith('image/') && (file.fileId || typeof file.text === 'string'));
    if (!docFiles.length) return '';
    return `<div class="msg-files">${docFiles.map(file => {
      const type = file.type || '文件';
      const size = Attachments.formatBytes(file.size);
      const status = file.missing ? '附件数据已丢失' : (file.extractionLabel || (Attachments.isTextFile(file) ? '源码文本输入' : '文本兼容输入'));
      const meta = [type, size, status].filter(Boolean).join(' · ');
      return `
        <div class="msg-file" title="${esc(file.name || '附件')}">
          <span class="msg-file-icon">${renderMessageFileIcon()}</span>
          <span class="msg-file-info">
            <span class="msg-file-name">${esc(file.name || '附件')}</span>
            <span class="msg-file-meta">${esc(meta || '已随消息发送')}</span>
          </span>
        </div>
      `;
    }).join('')}</div>`;
  }

  window.OwnChatChatRenderer = {
    messageTextContent,
    copyableMessageText,
    copyableMessagePlainText,
    formatShortDuration,
    renderMessages,
    renderMessage,
    renderMessageFileAttachments,
  };
})();

// ===== Sidebar Renderer =====
(function () {
  'use strict';

  const { esc } = window.OwnChatMarkdown;
  const ChatRenderer = window.OwnChatChatRenderer;

  const CHAT_NEW_BUTTON_HTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
    新对话
  `;

  const IMAGE_NEW_BUTTON_HTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/>
      <path d="M21 15l-5-5L5 21"/>
    </svg>
    新绘画
  `;

  const RENAME_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';

  function normalizedSearch(search) {
    return String(search || '').trim().toLowerCase();
  }

  function imageJobTitle(job) {
    return job?.title || job?.prompt || '未命名绘画';
  }

  function renderBulkCheckbox(id, label, bulkMode, selectedIds) {
    if (!bulkMode) return '';
    const checked = selectedIds?.has(id) ? ' checked' : '';
    return `<label class="conv-item-check" title="选择${esc(label)}">
      <input type="checkbox" data-action="bulk-check" data-id="${esc(id)}"${checked}>
      <span></span>
    </label>`;
  }

  function renderSidebarItem({ id, title, active, bulkMode, selectedIds, type = '' }) {
    return `
      <div class="conv-item ${active ? 'active' : ''} ${bulkMode ? 'bulk-mode' : ''} ${type ? `type-${esc(type)}` : ''}" data-id="${esc(id)}" data-type="${esc(type)}">
        ${renderBulkCheckbox(id, title, bulkMode, selectedIds)}
        <span class="conv-item-title">${esc(title)}</span>
        <button class="conv-item-rename" type="button" title="重命名">${RENAME_ICON}</button>
        <button class="conv-item-delete" type="button" title="删除">&times;</button>
      </div>
    `;
  }

  function buildImageView({ jobs, search, currentId, bulkMode, selectedIds, isLoading }) {
    if (isLoading) {
      return {
        searchPlaceholder: '搜索绘画...',
        newButtonHtml: IMAGE_NEW_BUTTON_HTML,
        visibleIds: [],
        listHtml: '<div class="sidebar-empty">正在加载绘画历史...</div>',
      };
    }

    const q = normalizedSearch(search);
    const filtered = q
      ? (jobs || []).filter(job => `${job.title || ''} ${job.prompt || ''} ${job.model || ''}`.toLowerCase().includes(q))
      : (jobs || []);
    const visibleIds = filtered.map(job => job.id);

    return {
      searchPlaceholder: '搜索绘画...',
      newButtonHtml: IMAGE_NEW_BUTTON_HTML,
      visibleIds,
      listHtml: filtered.map(job => {
        const isCanvas = job?.kind === 'canvas';
        return renderSidebarItem({
          id: job.id,
          title: isCanvas ? `无限画布 · ${imageJobTitle(job)}` : imageJobTitle(job),
          active: job.id === currentId,
          bulkMode,
          selectedIds,
          type: isCanvas ? 'canvas' : 'image',
        });
      }).join('') || '<div class="sidebar-empty">没有匹配的绘画</div>',
    };
  }

  function buildChatView({ conversations, search, currentId, bulkMode, selectedIds }) {
    const q = normalizedSearch(search);
    const filtered = q
      ? (conversations || []).filter(conv => {
          const body = (conv.messages || []).map(ChatRenderer.messageTextContent).join(' ');
          return `${conv.title || ''} ${conv.systemPrompt || ''} ${body}`.toLowerCase().includes(q);
        })
      : (conversations || []);
    const visibleIds = filtered.map(conv => conv.id);

    return {
      searchPlaceholder: '搜索对话...',
      newButtonHtml: CHAT_NEW_BUTTON_HTML,
      visibleIds,
      listHtml: filtered.map(conv => renderSidebarItem({
        id: conv.id,
        title: conv.title || '未命名对话',
        active: conv.id === currentId,
        bulkMode,
        selectedIds,
      })).join('') || '<div class="sidebar-empty">没有匹配的对话</div>',
    };
  }

  function bulkBarState({ visibleIds, selectedIds, bulkMode }) {
    const ids = Array.isArray(visibleIds) ? visibleIds : [];
    const selected = ids.filter(id => selectedIds?.has(id)).length;
    return {
      active: !!bulkMode,
      total: ids.length,
      selected,
      selectAllDisabled: ids.length === 0,
      selectAllText: ids.length > 0 && selected === ids.length ? '取消全选' : '全选',
      deleteDisabled: selected === 0,
      deleteText: selected ? `删除 ${selected}` : '删除',
    };
  }

  function applyBulkBar(elements, state) {
    elements.bar.classList.toggle('is-active', state.active);
    elements.toggle.classList.toggle('hidden', state.active);
    elements.selectAll.classList.toggle('hidden', !state.active);
    elements.delete.classList.toggle('hidden', !state.active);
    elements.cancel.classList.toggle('hidden', !state.active);
    elements.selectAll.disabled = state.selectAllDisabled;
    elements.selectAll.textContent = state.selectAllText;
    elements.delete.disabled = state.deleteDisabled;
    elements.delete.textContent = state.deleteText;
  }

  window.OwnChatSidebarRenderer = {
    buildImageView,
    buildChatView,
    bulkBarState,
    applyBulkBar,
  };
})();

// ===== Stream UI =====
(function () {
  'use strict';

  const Markdown = window.OwnChatMarkdown;
  const ChatRenderer = window.OwnChatChatRenderer;

  let streamRafPending = false;
  let streamRafCallbacks = new Map();
  const AUTO_SCROLL_THRESHOLD = 96;

  function isNearBottom(messagesEl, threshold = AUTO_SCROLL_THRESHOLD) {
    if (!messagesEl) return true;
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= threshold;
  }

  function scrollToBottom(messagesEl) {
    if (!messagesEl) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function maybeScrollToBottom(messagesEl, shouldFollow) {
    if (shouldFollow) scrollToBottom(messagesEl);
  }

  function scheduleStreamRender(callback, renderKey = callback) {
    if (typeof callback !== 'function') return;
    streamRafCallbacks.set(renderKey, callback);
    if (streamRafPending) return;
    streamRafPending = true;
    requestAnimationFrame(() => {
      streamRafPending = false;
      const callbacks = Array.from(streamRafCallbacks.values());
      streamRafCallbacks = new Map();
      callbacks.forEach(fn => fn());
    });
  }

  function addTyping(messagesEl, welcomeEl, onBeforeAppend, aiAvatar) {
    const el = document.createElement('div');
    el.className = 'chat-msg ai';
    el.id = 'typing-el';
    el.innerHTML = `
      <div class="chat-msg-inner">
        <div class="chat-msg-avatar">${aiAvatar || ''}</div>
        <div class="chat-msg-body">
          <div class="typing-dots"><span></span><span></span><span></span></div>
        </div>
      </div>
    `;
    messagesEl.classList.add('has-messages');
    welcomeEl.classList.add('hidden');
    if (typeof onBeforeAppend === 'function') onBeforeAppend();
    messagesEl.appendChild(el);
    scrollToBottom(messagesEl);
    return el;
  }

  function removeTyping(doc = document) {
    doc.getElementById('typing-el')?.remove();
  }

  function addStreamMsg(messagesEl, aiAvatar) {
    const shouldFollow = isNearBottom(messagesEl);
    const el = document.createElement('div');
    el.className = 'chat-msg ai';
    el.id = 'stream-el';
    el.innerHTML = `
      <div class="chat-msg-inner">
        <div class="chat-msg-avatar">${aiAvatar || ''}</div>
        <div class="chat-msg-body">
          <div class="stream-waiting">
            <div class="typing-dots"><span></span><span></span><span></span></div>
          </div>
          <div class="thinking-block hidden">
            <button class="thinking-toggle" type="button">
              <svg class="thinking-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              <span class="thinking-label">思考中...</span>
            </button>
            <div class="thinking-content"><div class="msg-md"></div></div>
          </div>
          <div class="msg-md"></div>
        </div>
      </div>
    `;
    messagesEl.appendChild(el);
    maybeScrollToBottom(messagesEl, shouldFollow);
    return {
      thinkingMd: el.querySelector('.thinking-content .msg-md'),
      thinkingBlock: el.querySelector('.thinking-block'),
      thinkingLabel: el.querySelector('.thinking-label'),
      contentMd: el.querySelector('.chat-msg-body > .msg-md'),
      waiting: el.querySelector('.stream-waiting'),
    };
  }

  function updateStream(messagesEl, el, text) {
    const shouldFollow = isNearBottom(messagesEl);
    scheduleStreamRender(() => {
      el.innerHTML = Markdown.renderMd(text);
      maybeScrollToBottom(messagesEl, shouldFollow);
    }, el);
  }

  function renderStreamContent(messagesEl, streamEls, content, opts = {}) {
    const shouldFollow = isNearBottom(messagesEl);
    scheduleStreamRender(() => {
      if (opts.hideWaiting !== false) streamEls.waiting?.classList.add('hidden');
      streamEls.contentMd.innerHTML = Markdown.renderMd(content);
      maybeScrollToBottom(messagesEl, shouldFollow);
    }, streamEls?.contentMd || streamEls);
  }

  function showThinkingContent(messagesEl, streamEls, reasoningContent, opts = {}) {
    if (!streamEls?.thinkingBlock || !reasoningContent || opts.showThinking === false) return;
    const shouldFollow = isNearBottom(messagesEl);
    scheduleStreamRender(() => {
      streamEls.waiting?.classList.add('hidden');
      streamEls.thinkingBlock.classList.remove('hidden');
      if (opts.resetUserToggle) delete streamEls.thinkingBlock.dataset.userToggled;
      if (opts.expanded !== false && streamEls.thinkingBlock.dataset.userToggled !== 'true') {
        streamEls.thinkingBlock.classList.add('expanded');
      }
      streamEls.thinkingMd.innerHTML = Markdown.renderMd(reasoningContent);
      if (opts.label) streamEls.thinkingLabel.textContent = opts.label;
      maybeScrollToBottom(messagesEl, shouldFollow);
    }, streamEls.thinkingMd);
  }

  function updateThinkingStream(messagesEl, streamEls, reasoningContent, reasoningStartTime, streamStartTime, showThinking) {
    if (!showThinking || !reasoningContent) return;
    const shouldFollow = isNearBottom(messagesEl);
    scheduleStreamRender(() => {
      streamEls.waiting?.classList.add('hidden');
      if (streamEls.thinkingBlock.classList.contains('hidden')) {
        streamEls.thinkingBlock.classList.remove('hidden');
      }
      if (!streamEls.thinkingDone && streamEls.thinkingBlock.dataset.userToggled !== 'true') {
        streamEls.thinkingBlock.classList.add('expanded');
      }
      const thinkingMs = Date.now() - (reasoningStartTime || streamStartTime);
      if (!streamEls.thinkingDone) streamEls.thinkingLabel.textContent = `思考中... · ${ChatRenderer.formatShortDuration(thinkingMs)}`;
      streamEls.thinkingMd.innerHTML = Markdown.renderMd(reasoningContent);
      maybeScrollToBottom(messagesEl, shouldFollow);
    }, streamEls.thinkingMd);
  }

  function finishThinkingStream(streamEls, reasoningStartTime, streamStartTime, endedAt = Date.now(), reasoningContent = '') {
    if (!streamEls?.thinkingBlock || streamEls.thinkingBlock.classList.contains('hidden')) return null;
    const thinkingMs = endedAt - (reasoningStartTime || streamStartTime);
    applyThinkingDoneLabel(streamEls, thinkingMs, reasoningContent);
    return thinkingMs;
  }

  function hideEmptyThinkingStream(streamEls) {
    if (!streamEls?.thinkingBlock || streamEls.thinkingMd?.textContent?.trim()) return;
    streamEls.thinkingBlock.classList.add('hidden');
    streamEls.thinkingBlock.classList.remove('expanded');
    delete streamEls.thinkingBlock.dataset.userToggled;
  }

  function applyThinkingDoneLabel(streamEls, thinkingMs, reasoningContent = '') {
    if (!streamEls?.thinkingBlock) return;
    streamEls.thinkingDone = true;
    streamEls.thinkingBlock.classList.remove('expanded');
    delete streamEls.thinkingBlock.dataset.userToggled;
    if (reasoningContent) streamEls.thinkingMd.innerHTML = Markdown.renderMd(reasoningContent);
    if (Number.isFinite(thinkingMs)) streamEls.thinkingLabel.textContent = `思考过程 · ${ChatRenderer.formatShortDuration(thinkingMs)}`;
    else streamEls.thinkingLabel.textContent = '思考过程';
  }

  window.OwnChatStreamUi = {
    scheduleStreamRender,
    addTyping,
    removeTyping,
    addStreamMsg,
    isNearBottom,
    scrollToBottom,
    maybeScrollToBottom,
    updateStream,
    renderStreamContent,
    showThinkingContent,
    updateThinkingStream,
    finishThinkingStream,
    hideEmptyThinkingStream,
    applyThinkingDoneLabel,
  };
})();

// ===== Stream Session Poller =====
(function () {
  'use strict';

  const Stream = window.OwnChatStream;

  function createProgressState(seed = {}) {
    const now = Date.now();
    return {
      streamStartTime: numberOr(seed.streamStartTime, now),
      firstTokenTime: nullableNumber(seed.firstTokenTime),
      outputStartTime: nullableNumber(seed.outputStartTime),
      reasoningStartTime: nullableNumber(seed.reasoningStartTime),
      reasoningEndTime: nullableNumber(seed.reasoningEndTime),
      lastContent: seed.lastContent || '',
    };
  }

  function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function nullableNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeSession(session) {
    return {
      content: session?.assistantContent || '',
      reasoning: session?.reasoningContent || '',
      usage: Stream.normalizeUsage(session?.usage),
      status: session?.status || '',
    };
  }

  function isTerminalSession(session) {
    return session?.status === 'complete' || session?.status === 'error' || session?.status === 'stopped';
  }

  function applyProgress(state, session, now = Date.now()) {
    const progress = normalizeSession(session);

    if (progress.content && state.firstTokenTime === null) {
      state.firstTokenTime = now - state.streamStartTime;
      state.outputStartTime = now;
    }
    if (progress.reasoning && state.reasoningStartTime === null) {
      state.reasoningStartTime = now;
    }
    if (progress.reasoning && progress.content && state.reasoningEndTime === null) {
      state.reasoningEndTime = now;
    }

    const contentChanged = progress.content !== state.lastContent;
    if (contentChanged) state.lastContent = progress.content;

    return Object.assign({ contentChanged }, progress);
  }

  function outputTimeMs(state, session, endedAt = Date.now()) {
    const sessionOutputTimeMs = session?.outputTimeMs != null ? Number(session.outputTimeMs) : null;
    if (Number.isFinite(sessionOutputTimeMs)) return sessionOutputTimeMs;
    const localOutputTimeMs = state.outputStartTime ? endedAt - state.outputStartTime : null;
    return Number.isFinite(localOutputTimeMs) ? localOutputTimeMs : null;
  }

  function reasoningTimeMs(state) {
    if (state.reasoningEndTime === null) return null;
    return state.reasoningEndTime - (state.reasoningStartTime || state.streamStartTime);
  }

  function ensureSessionOutputTime(session, state, now = Date.now()) {
    if (!session || session.outputTimeMs != null) return;
    const time = outputTimeMs(state, session, now);
    if (Number.isFinite(time)) session.outputTimeMs = time;
  }

  window.OwnChatStreamSessionPoller = {
    createProgressState,
    normalizeSession,
    isTerminalSession,
    applyProgress,
    outputTimeMs,
    reasoningTimeMs,
    ensureSessionOutputTime,
  };
})();

// ===== App Controller =====
(function () {
  'use strict';

  const { KEYS, save, load } = window.OwnChatStorage;
  const { renderMd, esc, splitThinkTags } = window.OwnChatMarkdown;
  const {
    DEFAULT_CONTEXT_LIMIT,
    estimateTokens,
    tokensToK,
    kToTokens,
    explicitMaxTokens,
    trimContextMessages,
    apiMessagesTokenCount,
    estimateMessageTokens,
    formatTokenCount,
  } = window.OwnChatTokens;
  const {
    IMAGE_KEY,
    setImageSaveErrorHandler,
    imageDbGetAllJobs,
    imageDbPutJob,
    imageDbDeleteJob,
    imageDbClearJobs,
    fileDbPut,
    fileDbGetAll,
    fileDbDelete,
    fileDbClearAll,
    writeStreamSession,
    getStreamSession,
    getStableStreamSession,
    clearStreamSession,
    getImageSession,
    normalizeImageSession,
    parseImageSessionOutputs,
    clearImageSession,
    clearImageSessionForJob,
    writeImageSession,
    collectConversationFileIds,
    collectDeletedOnlyFileIds: collectDeletedOnlyFileIdsFor,
    stripFilesFromConversations,
    hydrateFilesInConversations,
  } = window.OwnChatDb;
  const Attachments = window.OwnChatAttachments;
  const ImageCore = window.OwnChatImageCore;
  const ImageRenderer = window.OwnChatImageRenderer;
  const ChatRenderer = window.OwnChatChatRenderer;
  const StreamUi = window.OwnChatStreamUi;
  const StreamSessionPoller = window.OwnChatStreamSessionPoller;
  const Api = window.OwnChatApi;
  const ServiceWorker = window.OwnChatServiceWorker;
  const ConfigImport = window.OwnChatConfigImport;
  const UiUtils = window.OwnChatUiUtils;
  const Icons = window.OwnChatIcons;
  const ImageViewer = window.OwnChatImageViewer;
  const ImageApi = window.OwnChatImageApi;
  const SidebarRenderer = window.OwnChatSidebarRenderer;
  const Dialogs = window.OwnChatDialogs;
  const {
    imageJobReplies,
    ensureImageJobReplies,
    currentImageActiveReply,
    imageReplyOutput,
    dataUrlForImage,
    imageByteSize,
    isRenderableImageOutput,
    normalizeImageFormat,
    imageOutputMeta,
    imageFilename,
    attachmentImageFilename,
    formatDuration,
    formatDateTime,
    imageStaleTimeoutMs,
    setImageJobDone,
    setImageJobFailed,
    completeImageJobFromSession,
    failImageJobFromSession,
  } = ImageCore;

  // ===== State =====
  const DEFAULT_IMAGE_MODELS = ['gpt-image-2', 'gpt-image-2-2026-04-21', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3', 'dall-e-2'];
  const DEFAULT_IMAGE_PARAMS = { size: 'auto', quality: 'auto', outputFormat: 'png', background: 'auto', count: 1 };
  const MAX_IMAGE_REFS = 16;
  const MAX_IMAGE_COUNT = 10;
  const MAX_CANVAS_PARALLEL = 3;

  const initialMode = load(KEYS.mode);
  const endpointIdPrefix = kind => `oc-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const endpointLabel = (kind, index) => kind === 'chat' ? `对话接口 ${index + 1}` : `绘画接口 ${index + 1}`;
  const endpointModelDefaults = kind => kind === 'image' ? DEFAULT_IMAGE_MODELS : [];

  function normalizeModelsList(models, fallback = []) {
    return mergeUnique(Array.isArray(models) ? models : [], fallback);
  }

  function sanitizeEndpoint(raw, kind = 'chat', index = 0, fallback = {}) {
    const baseUrl = typeof raw?.baseUrl === 'string' ? raw.baseUrl.trim() : (fallback.baseUrl || '');
    const apiKey = typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : (fallback.apiKey || '');
    const model = typeof raw?.model === 'string' ? raw.model.trim() : (fallback.model || '');
    const models = normalizeModelsList(raw?.models, fallback.models || endpointModelDefaults(kind));
    const name = (typeof raw?.name === 'string' && raw.name.trim())
      ? raw.name.trim()
      : (fallback.name || endpointLabel(kind, index));
    return {
      id: (typeof raw?.id === 'string' && raw.id.trim()) ? raw.id.trim() : (fallback.id || endpointIdPrefix(kind)),
      name: name.slice(0, 40),
      baseUrl,
      apiKey,
      model,
      models: mergeUnique(model ? [model] : [], models),
    };
  }

  function migrateEndpoints(kind, savedEndpoints, legacy = {}) {
    const fallbackModels = endpointModelDefaults(kind);
    let endpoints = Array.isArray(savedEndpoints)
      ? savedEndpoints.map((item, index) => sanitizeEndpoint(item, kind, index, { models: fallbackModels }))
      : [];
    endpoints = endpoints.filter((item, index, list) => item.id && list.findIndex(other => other.id === item.id) === index);
    if (!endpoints.length) {
      endpoints = [sanitizeEndpoint({}, kind, 0, {
        id: 'default',
        name: kind === 'chat' ? '默认对话接口' : '默认绘画接口',
        baseUrl: legacy.baseUrl || '',
        apiKey: legacy.apiKey || '',
        model: legacy.model || '',
        models: mergeUnique(legacy.model ? [legacy.model] : [], legacy.models || [], fallbackModels),
      })];
    } else if (legacy.model) {
      const first = endpoints[0];
      first.models = mergeUnique(first.model ? [first.model] : [], [legacy.model], first.models, legacy.models || [], fallbackModels);
    }
    return endpoints;
  }

  const state = {
    appClientId: (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    mode: initialMode === 'canvas' ? 'image' : (initialMode || 'chat'),
    chatEndpoints: migrateEndpoints('chat', load(KEYS.chatEndpoints), {
      baseUrl: load(KEYS.baseUrl) || '',
      apiKey: load(KEYS.apiKey) || '',
      model: load(KEYS.model) || '',
      models: load(KEYS.modelsCache) || [],
    }),
    currentChatEndpointId: load(KEYS.currentChatEndpointId) || 'default',
    baseUrl: '',
    apiKey: '',
    model: '',
    modelsCache: [],
    conversations: load(KEYS.conversations) || [],
    currentConvId: load(KEYS.currentConvId) || null,
    sidebarCollapsed: load(KEYS.sidebarCollapsed) || false,
    theme: load(KEYS.theme) || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
    imageEndpoints: migrateEndpoints('image', load(KEYS.imageEndpoints), {
      baseUrl: load(KEYS.imageBaseUrl) || '',
      apiKey: load(KEYS.imageApiKey) || '',
      model: load(KEYS.imageModel) || 'gpt-image-2',
      models: load(KEYS.imageModelsCache) || DEFAULT_IMAGE_MODELS,
    }),
    currentImageEndpointId: load(KEYS.currentImageEndpointId) || 'default',
    imageBaseUrl: '',
    imageApiKey: '',
    imageModel: '',
    imageMapModel: load(KEYS.imageMapModel) || '',
    imagePromptModel: load(KEYS.imagePromptModel) || '',
    imageModelsCache: [],
    imageJobs: [],
    currentImageJobId: load(KEYS.currentImageJobId) || null,
    imageDefaults: Object.assign({}, DEFAULT_IMAGE_PARAMS, load(KEYS.imageDefaults) || {}),
    imageCanvasMode: !!load(KEYS.imageCanvasMode),
    isStreaming: false,
    streamingConvId: null,
    chatAbortController: null,
    chatPollTimer: null,
    chatWakeLock: null,
    streamEls: null,
    isGeneratingImage: false,
    imageAbortController: null,
    imageRetryContext: null,
    imageProgressTimer: null,
    imagePollTimer: null,
    imageWakeLock: null,
    imageCanvasViewportSaveTimer: null,
    isImageHistoryLoading: false,
    isOptimizingImagePrompt: false,
    textareaResize: null,
    imageRefs: [],
    imageCanvasPointer: null,
    imageCanvasConnectFrom: null,
    imageCanvasSelectedEdgeId: null,
    imageCanvasPlannerOpen: false,
    imageCanvasPlannerTopic: '',
    imageCanvasPlannerTemplate: 'free',
    imageCanvasPlannerComplexity: 'standard',
    imageCanvasPlannerRefs: [],
    pendingFiles: [],
    sidebarSearch: '',
    sidebarBulkMode: false,
    sidebarSelectedIds: new Set(),
    sidebarVisibleIds: [],
    pendingImportConfig: null,
    settingsSnapshot: null,
  };

  function endpointList(kind) {
    return kind === 'image' ? state.imageEndpoints : state.chatEndpoints;
  }

  function currentEndpointId(kind) {
    return kind === 'image' ? state.currentImageEndpointId : state.currentChatEndpointId;
  }

  function setCurrentEndpointId(kind, id) {
    if (kind === 'image') state.currentImageEndpointId = id;
    else state.currentChatEndpointId = id;
  }

  function ensureEndpoint(kind = 'chat') {
    const list = endpointList(kind);
    if (!Array.isArray(list) || !list.length) {
      const endpoint = sanitizeEndpoint({}, kind, 0, {
        id: 'default',
        name: kind === 'image' ? '默认绘画接口' : '默认对话接口',
        model: kind === 'image' ? 'gpt-image-2' : '',
        models: endpointModelDefaults(kind),
      });
      if (kind === 'image') state.imageEndpoints = [endpoint];
      else state.chatEndpoints = [endpoint];
    }
    const nextList = endpointList(kind);
    let endpoint = nextList.find(item => item.id === currentEndpointId(kind));
    if (!endpoint) {
      endpoint = nextList[0];
      setCurrentEndpointId(kind, endpoint.id);
    }
    return endpoint;
  }

  function currentChatEndpoint() {
    return ensureEndpoint('chat');
  }

  function currentImageEndpoint() {
    return ensureEndpoint('image');
  }

  function syncLegacyFromEndpoints() {
    const chat = currentChatEndpoint();
    state.baseUrl = chat?.baseUrl || '';
    state.apiKey = chat?.apiKey || '';
    state.model = chat?.model || '';
    state.modelsCache = mergeUnique(chat?.model ? [chat.model] : [], chat?.models || []);

    const image = currentImageEndpoint();
    state.imageBaseUrl = image?.baseUrl || '';
    state.imageApiKey = image?.apiKey || '';
    state.imageModel = image?.model || 'gpt-image-2';
    state.imageModelsCache = mergeUnique(image?.model ? [image.model] : [], image?.models || [], DEFAULT_IMAGE_MODELS);
  }

  function updateEndpoint(kind, values = {}) {
    const endpoint = ensureEndpoint(kind);
    Object.assign(endpoint, values);
    endpoint.name = (endpoint.name || endpointLabel(kind, endpointList(kind).indexOf(endpoint))).trim().slice(0, 40);
    endpoint.models = mergeUnique(endpoint.model ? [endpoint.model] : [], endpoint.models || [], endpointModelDefaults(kind));
    syncLegacyFromEndpoints();
    return endpoint;
  }

  function createEndpoint(kind = 'chat') {
    const list = endpointList(kind);
    const endpoint = sanitizeEndpoint({}, kind, list.length, {
      name: endpointLabel(kind, list.length),
      model: kind === 'image' ? 'gpt-image-2' : '',
      models: endpointModelDefaults(kind),
    });
    list.push(endpoint);
    setCurrentEndpointId(kind, endpoint.id);
    syncLegacyFromEndpoints();
    return endpoint;
  }

  function deleteCurrentEndpoint(kind = 'chat') {
    const list = endpointList(kind);
    if (list.length <= 1) return false;
    const id = currentEndpointId(kind);
    const idx = Math.max(0, list.findIndex(item => item.id === id));
    list.splice(idx, 1);
    setCurrentEndpointId(kind, list[Math.max(0, idx - 1)]?.id || list[0].id);
    syncLegacyFromEndpoints();
    return true;
  }

  function selectEndpoint(kind, id) {
    const list = endpointList(kind);
    if (list.some(item => item.id === id)) {
      setCurrentEndpointId(kind, id);
      syncLegacyFromEndpoints();
    }
    return ensureEndpoint(kind);
  }

  function allChatModels() {
    return mergeUnique(...state.chatEndpoints.map(endpoint => mergeUnique(endpoint.model ? [endpoint.model] : [], endpoint.models || [])));
  }

  function allImageModels() {
    return mergeUnique(...state.imageEndpoints.map(endpoint => mergeUnique(endpoint.model ? [endpoint.model] : [], endpoint.models || [])), DEFAULT_IMAGE_MODELS);
  }

  syncLegacyFromEndpoints();

  function persist(keys) {
    syncLegacyFromEndpoints();
    if (!keys) keys = Object.values(KEYS);
    let fileMap = [];
    if (keys.includes(KEYS.conversations)) {
      const { stripped, fileMap: fm } = stripFilesFromConversations(state.conversations);
      fileMap = fm;
      save(KEYS.conversations, stripped);
    }
    for (const k of keys) {
      if (k === KEYS.conversations) continue;
      const stateName = Object.keys(KEYS).find(n => KEYS[n] === k);
      if (stateName) save(k, state[stateName]);
    }
    return saveFileMap(fileMap);
  }

  async function persistDurable(keys) {
    syncLegacyFromEndpoints();
    if (!keys) keys = Object.values(KEYS);
    let strippedConversations = null;
    let fileResult = { total: 0, failed: 0 };
    if (keys.includes(KEYS.conversations)) {
      const { stripped, fileMap } = stripFilesFromConversations(state.conversations);
      strippedConversations = stripped;
      fileResult = await saveFileMap(fileMap);
    }
    if (fileResult.failed) return fileResult;
    if (strippedConversations) save(KEYS.conversations, strippedConversations);
    for (const k of keys) {
      if (k === KEYS.conversations) continue;
      const stateName = Object.keys(KEYS).find(n => KEYS[n] === k);
      if (stateName) save(k, state[stateName]);
    }
    return fileResult;
  }

  async function saveFileMap(fileMap) {
    if (!fileMap.length) return { total: 0, failed: 0 };
    const results = await Promise.all(fileMap.map(fileDbPut));
    return { total: results.length, failed: results.filter(ok => !ok).length };
  }

  function applyImportedConfig(cfg) {
    const summary = ConfigImport.summary(cfg);
    if (summary.chatEndpoints.length) {
      state.chatEndpoints = migrateEndpoints('chat', summary.chatEndpoints, {
        baseUrl: summary.chatBaseUrl,
        apiKey: summary.chatApiKey,
        model: summary.chatModel,
        models: summary.chatModels,
      });
      state.currentChatEndpointId = summary.currentChatEndpointId || state.chatEndpoints[0].id;
    } else if (summary.chatBaseUrl || summary.chatApiKey || summary.chatModel || summary.chatModels.length) {
      updateEndpoint('chat', {
        baseUrl: summary.chatBaseUrl ? normalizeUrl(summary.chatBaseUrl) : currentChatEndpoint().baseUrl,
        apiKey: summary.chatApiKey || currentChatEndpoint().apiKey,
        model: summary.chatModel || currentChatEndpoint().model,
        models: mergeUnique(summary.chatModel ? [summary.chatModel] : [], summary.chatModels, currentChatEndpoint().models),
      });
    }
    if (summary.imageEndpoints.length) {
      state.imageEndpoints = migrateEndpoints('image', summary.imageEndpoints, {
        baseUrl: summary.imageBaseUrl,
        apiKey: summary.imageApiKey,
        model: summary.imageModel,
        models: summary.imageModels,
      });
      state.currentImageEndpointId = summary.currentImageEndpointId || state.imageEndpoints[0].id;
    } else if (summary.imageBaseUrl || summary.imageApiKey || summary.imageModel || summary.imageModels.length) {
      updateEndpoint('image', {
        baseUrl: summary.imageBaseUrl ? normalizeUrl(summary.imageBaseUrl) : currentImageEndpoint().baseUrl,
        apiKey: summary.imageApiKey || currentImageEndpoint().apiKey,
        model: summary.imageModel || currentImageEndpoint().model,
        models: mergeUnique(summary.imageModel ? [summary.imageModel] : [], summary.imageModels, currentImageEndpoint().models, DEFAULT_IMAGE_MODELS),
      });
    }
    if (summary.hasImageMapModel) state.imageMapModel = summary.imageMapModel;
    if (summary.hasImagePromptModel) state.imagePromptModel = summary.imagePromptModel;
    if (summary.imageDefaults) state.imageDefaults = Object.assign({}, DEFAULT_IMAGE_PARAMS, summary.imageDefaults);
    syncLegacyFromEndpoints();
    if (summary.chatModel && currentConv() && !currentConv().model) {
      currentConv().model = summary.chatModel;
      currentConv().endpointId = currentChatEndpoint().id;
    }
    state.imageDefaults = sanitizeImageParams(state.imageDefaults);
    if (['image', 'draw', 'painting'].includes(summary.mode)) state.mode = 'image';
    if (['chat', 'dialog', 'conversation'].includes(summary.mode)) state.mode = 'chat';
    persist();
    updateModelBadge();
    updateSendBtn();
    updateImageGenerateBtn();
    switchMode(isImageModeLike(state.mode) ? state.mode : 'chat');
  }

  function showConfigImportConfirm(cfg) {
    state.pendingImportConfig = cfg;
    const summary = ConfigImport.summary(cfg);
    dom.configImportPreview.innerHTML = [
      ['模式', summary.mode || '不修改'],
      ['对话接口数量', summary.chatEndpoints.length ? `${summary.chatEndpoints.length} 个` : '不修改'],
      ['对话 Base URL', summary.chatBaseUrl || '不修改'],
      ['对话 API Key', ConfigImport.maskKey(summary.chatApiKey)],
      ['对话模型', summary.chatModel || '不修改'],
      ['绘画接口数量', summary.imageEndpoints.length ? `${summary.imageEndpoints.length} 个` : '不修改'],
      ['绘画 Base URL', summary.imageBaseUrl || '不修改'],
      ['绘画 API Key', ConfigImport.maskKey(summary.imageApiKey)],
      ['绘画模型', summary.imageModel || '不修改'],
      ['映射模型', summary.hasImageMapModel ? (summary.imageMapModel || '关闭') : '不修改'],
      ['提示词优化模型', summary.hasImagePromptModel ? (summary.imagePromptModel || '关闭') : '不修改'],
    ].map(([k, v]) => `<div class="config-preview-row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
    showModal(dom.configImportModal);
  }

  function hideConfigImportConfirm() {
    state.pendingImportConfig = null;
    hideModal(dom.configImportModal);
  }

  function importConfigFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const hasConfig = ['config', 'config_b64', 'oc_config', 'oc_config_b64'].some(k => params.has(k));
    if (!hasConfig) return false;
    if (configured() || imageConfigured()) {
      ConfigImport.cleanUrl();
      showToast('已存在本地配置，已忽略 URL 配置');
      return false;
    }
    try {
      showConfigImportConfirm(ConfigImport.fromCurrentUrl());
      ConfigImport.cleanUrl();
      return true;
    } catch (e) {
      ConfigImport.cleanUrl();
      alert(`导入接口配置失败: ${e.message}`);
      return false;
    }
  }

  function currentConv() {
    return state.conversations.find(c => c.id === state.currentConvId);
  }

  function chatEndpointForConversation(conv = currentConv()) {
    const endpointId = conv?.endpointId || state.currentChatEndpointId;
    return state.chatEndpoints.find(endpoint => endpoint.id === endpointId) || currentChatEndpoint();
  }

  function conversationModel(conv = currentConv()) {
    return conv?.model || chatEndpointForConversation(conv)?.model || state.model || '';
  }

  function ensureConversationModel(conv = currentConv()) {
    const endpoint = chatEndpointForConversation(conv);
    if (conv && (!conv.endpointId || !state.chatEndpoints.some(item => item.id === conv.endpointId))) {
      conv.endpointId = endpoint?.id || state.currentChatEndpointId;
    }
    if (conv && !conv.model && endpoint?.model) conv.model = endpoint.model;
    return conversationModel(conv);
  }

  function conversationShowThinking(conv = currentConv()) {
    return conv?.showThinking !== false;
  }

  function conversationIncludeContext(conv = currentConv()) {
    return conv?.includeContextDefault !== undefined ? conv.includeContextDefault !== false : true;
  }

  function newConv() {
    const endpoint = currentChatEndpoint();
    const conv = { id: Date.now().toString(), title: '新对话', messages: [], createdAt: Date.now(), endpointId: endpoint.id, model: endpoint.model, temperature: 0.7, topP: 1, maxTokens: null, contextLimit: DEFAULT_CONTEXT_LIMIT, systemPrompt: '', showThinking: true, includeContextDefault: true };
    state.conversations.unshift(conv);
    state.currentConvId = conv.id;
    persist();
    return conv;
  }

  function effectiveImageBaseUrl() {
    return (currentImageEndpoint()?.baseUrl || currentChatEndpoint()?.baseUrl || '').trim();
  }

  function effectiveImageApiKey() {
    return (currentImageEndpoint()?.apiKey || currentChatEndpoint()?.apiKey || '').trim();
  }

  function effectiveImageEndpoint() {
    return {
      baseUrl: effectiveImageBaseUrl(),
      apiKey: effectiveImageApiKey(),
      endpointId: currentImageEndpoint()?.id || '',
    };
  }

  function configured() {
    const endpoint = chatEndpointForConversation();
    return endpoint?.baseUrl && endpoint.apiKey && (endpoint.model || conversationModel());
  }
  function imageConfigured() { return effectiveImageBaseUrl() && effectiveImageApiKey() && state.imageModel; }
  function parseSourcedModelRef(value, fallback = 'image') {
    const raw = (value || '').trim();
    const match = raw.match(/^(chat|image):(.+)$/i);
    if (match) return { source: match[1].toLowerCase(), model: match[2].trim(), value: `${match[1].toLowerCase()}:${match[2].trim()}` };

    const hasImageModel = allImageModels().includes(raw) || DEFAULT_IMAGE_MODELS.includes(raw);
    const hasChatModel = allChatModels().includes(raw) || raw === state.model || raw === conversationModel();
    const source = hasChatModel && !hasImageModel ? 'chat' : fallback;
    return { source, model: raw, value: raw ? `${source}:${raw}` : '' };
  }

  function parsePromptModelRef(value) {
    return parseSourcedModelRef(value, 'image');
  }

  function parseMapModelRef(value) {
    return parseSourcedModelRef(value, 'image');
  }

  function formatSourcedModel(value) {
    const ref = parseSourcedModelRef(value, 'image');
    if (!ref.model) return '';
    return `${ref.model} · ${ref.source === 'chat' ? '对话' : '绘画'}`;
  }

  function modelEndpoint(ref) {
    if (!ref?.model) return null;
    if (ref.source === 'chat') {
      const current = currentChatEndpoint();
      const convEndpoint = chatEndpointForConversation();
      const endpoint = [convEndpoint, current, ...state.chatEndpoints].find(item => item && (item.models?.includes(ref.model) || item.model === ref.model)) || current;
      return { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, source: 'chat', model: ref.model, endpointId: endpoint.id };
    }
    const current = currentImageEndpoint();
    const endpoint = [current, ...state.imageEndpoints].find(item => item && (item.models?.includes(ref.model) || item.model === ref.model)) || current;
    return { baseUrl: endpoint.baseUrl || currentChatEndpoint()?.baseUrl || '', apiKey: endpoint.apiKey || currentChatEndpoint()?.apiKey || '', source: 'image', model: ref.model, endpointId: endpoint.id };
  }

  function imagePromptEndpoint() {
    const ref = parsePromptModelRef(state.imagePromptModel);
    return modelEndpoint(ref);
  }

  function imageMapEndpoint() {
    const ref = parseMapModelRef(state.imageMapModel);
    return modelEndpoint(ref);
  }

  function imagePromptOptimizerConfigured() {
    const endpoint = imagePromptEndpoint();
    return endpoint?.baseUrl && endpoint.apiKey && state.imagePromptModel;
  }

  function imageMapConfigured() {
    if (!state.imageMapModel) return true;
    const endpoint = imageMapEndpoint();
    return !!(endpoint?.baseUrl && endpoint.apiKey && endpoint.model);
  }

  function contextMessagesForRequest(conv, currentUserMsg, includeContext) {
    if (!includeContext) return [currentUserMsg];
    const messages = conv?.messages || [];
    const currentIdx = messages.lastIndexOf(currentUserMsg);
    const searchEnd = currentIdx >= 0 ? currentIdx - 1 : messages.length - 1;
    for (let i = searchEnd; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === 'user' && msg.includeContext === false) {
        return messages.slice(i);
      }
    }
    return messages;
  }

  function buildChatRequestBody(conv, model, apiMessages) {
    const body = {
      model,
      messages: Attachments.apiMessagesFromPromptMessages(apiMessages),
      stream: true,
      temperature: conv.temperature,
      top_p: conv.topP,
      stream_options: { include_usage: true },
    };
    const maxTokens = explicitMaxTokens(conv);
    if (maxTokens) body.max_tokens = maxTokens;
    return body;
  }

  function usageOutputTokens(usage, fallback) {
    const normalized = OwnChatStream.normalizeUsage(usage);
    return normalized?.output ?? fallback;
  }

  function normalizeUrl(u) { return Api.normalizeUrl(u); }
  function requestUrl(baseUrl, path) { return Api.requestUrl(baseUrl, path); }
  function apiFetch(url, options = {}) { return Api.apiFetch(url, options); }
  function registerServiceWorker() { return ServiceWorker.register(); }
  function ensureServiceWorkerTarget(timeoutMs = 5000) { return ServiceWorker.ensureTarget(timeoutMs); }
  function httpError(status, message, url) {
    return Api.httpError(status, message, url, {
      mode: state.mode,
      chatModel: conversationModel(),
      imageModel: state.imageModel,
    });
  }

  function collectDeletedOnlyFileIds(deletedConversations) {
    return collectDeletedOnlyFileIdsFor(deletedConversations, state.conversations);
  }

  // ===== DOM =====
  const $ = id => document.getElementById(id);

  const dom = {
    sidebar: $('sidebar'),
    sidebarToggle: $('sidebar-toggle'),
    convList: $('conv-list'),
    newChatBtn: $('new-chat-btn'),
    sidebarBulkBar: $('sidebar-bulk-bar'),
    sidebarBulkToggle: $('sidebar-bulk-toggle'),
    sidebarBulkSelectAll: $('sidebar-bulk-select-all'),
    sidebarBulkDelete: $('sidebar-bulk-delete'),
    sidebarBulkCancel: $('sidebar-bulk-cancel'),
    modeChatBtn: $('mode-chat-btn'),
    modeImageBtn: $('mode-image-btn'),
    settingsBtn: $('settings-btn'),
    sidebarSearch: $('sidebar-search'),
    themeBtn: $('theme-btn'),
    sidebarBackdrop: $('sidebar-backdrop'),
    main: $('main'),
    header: $('header'),
    modelDropdownBtn: $('model-dropdown-btn'),
    modelDropdownList: $('model-dropdown-list'),
    currentModel: $('current-model'),
    modelDropdown: $('model-dropdown'),
    chatModelSlot: $('chat-model-slot'),
    imageModelSlot: $('image-model-slot'),
    messages: $('messages'),
    welcome: $('welcome'),
    imageWorkspace: $('image-workspace'),
    imageEmpty: $('image-empty'),
    imageCanvasWorkspace: $('image-canvas-workspace'),
    imageGallery: $('image-gallery'),
    convTokenSummary: $('conv-token-summary'),
    userInput: $('user-input'),
    sendBtn: $('send-btn'),
    inputArea: $('input-area'),
    imageInputArea: $('image-input-area'),
    imagePrompt: $('image-prompt'),
    imageSize: $('image-size'),
    imageQuality: $('image-quality'),
    imageCount: $('image-count'),
    imageFormat: $('image-format'),
    imageBackground: $('image-background'),
    imageBackgroundHint: $('image-background-hint'),
    imageRefInput: $('image-ref-input'),
    imageRefPreview: $('image-ref-preview'),
    imageRefBtn: $('image-ref-btn'),
    imageSettingsBtn: $('image-settings-btn'),
    imageSettingsPanel: $('image-settings-panel'),
    imageOptimizeBtn: $('image-optimize-btn'),
    imageCanvasToggleBtn: $('image-canvas-toggle-btn'),
    imageGenerateBtn: $('image-generate-btn'),
    // Settings modal
    settingsModal: $('settings-modal'),
    modalClose: $('modal-close'),
    settingsChatTab: $('settings-chat-tab'),
    settingsImageTab: $('settings-image-tab'),
    settingsChatPanel: $('settings-chat-panel'),
    settingsImagePanel: $('settings-image-panel'),
    cfgChatEndpointSelect: $('cfg-chat-endpoint-select'),
    cfgChatEndpointName: $('cfg-chat-endpoint-name'),
    cfgAddChatEndpoint: $('cfg-add-chat-endpoint'),
    cfgDeleteChatEndpoint: $('cfg-delete-chat-endpoint'),
    cfgBaseUrl: $('cfg-base-url'),
    cfgApiKey: $('cfg-api-key'),
    cfgModelSelect: $('cfg-model-select'),
    cfgRefreshModels: $('cfg-refresh-models'),
    cfgModelManual: $('cfg-model-manual'),
    cfgImageEndpointSelect: $('cfg-image-endpoint-select'),
    cfgImageEndpointName: $('cfg-image-endpoint-name'),
    cfgAddImageEndpoint: $('cfg-add-image-endpoint'),
    cfgDeleteImageEndpoint: $('cfg-delete-image-endpoint'),
    cfgImageBaseUrl: $('cfg-image-base-url'),
    cfgImageApiKey: $('cfg-image-api-key'),
    cfgImageModelSelect: $('cfg-image-model-select'),
    cfgRefreshImageModels: $('cfg-refresh-image-models'),
    cfgImageModelManual: $('cfg-image-model-manual'),
    cfgImageMapModelSelect: $('cfg-image-map-model-select'),
    cfgImageMapModelManual: $('cfg-image-map-model-manual'),
    cfgImagePromptModelSelect: $('cfg-image-prompt-model-select'),
    cfgImagePromptModelManual: $('cfg-image-prompt-model-manual'),
    imageViewer: $('image-viewer'),
    imageViewerImg: $('image-viewer-img'),
    imageViewerClose: $('image-viewer-close'),
    imageViewerPrev: $('image-viewer-prev'),
    imageViewerNext: $('image-viewer-next'),
    imageViewerCounter: $('image-viewer-counter'),
    imageViewerZoomOut: $('image-viewer-zoom-out'),
    imageViewerZoomReset: $('image-viewer-zoom-reset'),
    imageViewerZoomIn: $('image-viewer-zoom-in'),
    imageViewerCopy: $('image-viewer-copy'),
    imageViewerDownload: $('image-viewer-download'),
    cfgSave: $('cfg-save'),
    cfgCancel: $('cfg-cancel'),
    cfgExportConfig: $('cfg-export-config'),
    cfgImportFile: $('cfg-import-file'),
    cfgImportInput: $('cfg-import-input'),
    chatStorageSummary: $('chat-storage-summary'),
    imageStorageSummary: $('image-storage-summary'),
    browserStorageSummaryChat: $('browser-storage-summary-chat'),
    browserStorageSummaryImage: $('browser-storage-summary-image'),
    requestPersistentStorageChat: $('request-persistent-storage-chat'),
    requestPersistentStorageImage: $('request-persistent-storage-image'),
    clearChatStorage: $('clear-chat-storage'),
    clearImageStorage: $('clear-image-storage'),
    configImportModal: $('config-import-modal'),
    configImportPreview: $('config-import-preview'),
    configImportClose: $('config-import-close'),
    configImportApply: $('config-import-apply'),
    configImportCancel: $('config-import-cancel'),
    // Input params
    paramTemperature: $('param-temperature'),
    paramTopP: $('param-top-p'),
    paramMaxTokens: $('param-max-tokens'),
    paramContextLimit: $('param-context-limit'),
    convSettingsBtn: $('conv-settings-btn'),
    convSettingsPanel: $('conv-settings-panel'),
    convRenameInput: $('conv-rename-input'),
    convRoleInput: $('conv-role-input'),
    // File upload
    attachBtn: $('attach-btn'),
    thinkingToggleBtn: $('thinking-toggle-btn'),
    contextToggleBtn: $('context-toggle-btn'),
    fileInput: $('file-input'),
    filePreview: $('file-preview'),
    // Setup overlay
    setupOverlay: $('setup-overlay'),
    setupBaseUrl: $('setup-base-url'),
    setupApiKey: $('setup-api-key'),
    setupModelSelect: $('setup-model-select'),
    setupRefreshModels: $('setup-refresh-models'),
    setupSave: $('setup-save'),
    setupLater: $('setup-later'),
  };

  setImageSaveErrorHandler(() => {
    showToast('图片历史保存失败，当前页面仍可查看');
  });

  function scheduleStreamRender(callback) {
    StreamUi.scheduleStreamRender(callback);
  }

  // ===== Render Functions =====
  function isImageModeLike(mode = state.mode) {
    return mode === 'image';
  }

  function updateModelBadge() {
    dom.currentModel.textContent = isImageModeLike()
      ? (state.imageMapModel ? `映射 ${formatSourcedModel(state.imageMapModel)}` : (state.imageModel || '未配置'))
      : (conversationModel() || '未配置');
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
  }

  function updateModeA11y(mode = state.mode) {
    dom.modeChatBtn.setAttribute('aria-selected', mode === 'chat' ? 'true' : 'false');
    dom.modeImageBtn.setAttribute('aria-selected', mode === 'image' ? 'true' : 'false');
    dom.messages.setAttribute('aria-hidden', mode === 'chat' ? 'false' : 'true');
    dom.imageWorkspace.setAttribute('aria-hidden', isImageModeLike(mode) ? 'false' : 'true');
  }

  function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    persist();
  }

  function isMobile() {
    return window.innerWidth <= 768;
  }

  function canUseImageCanvas() {
    return !isMobile();
  }

  function closeSidebarMobile() {
    if (isMobile()) {
      state.sidebarCollapsed = true;
      dom.sidebar.classList.add('collapsed');
      dom.sidebarBackdrop.classList.add('hidden');
      persist();
    }
  }

  function updateSidebarBulkBar() {
    SidebarRenderer.applyBulkBar({
      bar: dom.sidebarBulkBar,
      toggle: dom.sidebarBulkToggle,
      selectAll: dom.sidebarBulkSelectAll,
      delete: dom.sidebarBulkDelete,
      cancel: dom.sidebarBulkCancel,
    }, SidebarRenderer.bulkBarState({
      visibleIds: state.sidebarVisibleIds,
      selectedIds: state.sidebarSelectedIds,
      bulkMode: state.sidebarBulkMode,
    }));
  }

  function updateSidebar() {
    if (isImageModeLike()) {
      const view = SidebarRenderer.buildImageView({
        jobs: state.imageJobs,
        search: state.sidebarSearch,
        currentId: state.currentImageJobId,
        bulkMode: state.sidebarBulkMode,
        selectedIds: state.sidebarSelectedIds,
        isLoading: state.isImageHistoryLoading,
      });
      dom.sidebarSearch.placeholder = view.searchPlaceholder;
      dom.newChatBtn.innerHTML = view.newButtonHtml;
      state.sidebarVisibleIds = view.visibleIds;
      state.sidebarSelectedIds = new Set([...state.sidebarSelectedIds].filter(id => state.sidebarVisibleIds.includes(id)));
      dom.convList.innerHTML = view.listHtml;
      updateSidebarBulkBar();
      return;
    }
    const view = SidebarRenderer.buildChatView({
      conversations: state.conversations,
      search: state.sidebarSearch,
      currentId: state.currentConvId,
      bulkMode: state.sidebarBulkMode,
      selectedIds: state.sidebarSelectedIds,
    });
    dom.sidebarSearch.placeholder = view.searchPlaceholder;
    dom.newChatBtn.innerHTML = view.newButtonHtml;
    state.sidebarVisibleIds = view.visibleIds;
    state.sidebarSelectedIds = new Set([...state.sidebarSelectedIds].filter(id => state.sidebarVisibleIds.includes(id)));
    dom.convList.innerHTML = view.listHtml;
    updateSidebarBulkBar();
  }

  function updateSendBtn() {
    const hasText = !!dom.userInput.value.trim();
    const hasReadyFiles = state.pendingFiles.some(Attachments.isReady);
    const hasFailedAttachments = state.pendingFiles.some(Attachments.hasError);
    const hasLoadingFiles = state.pendingFiles.some(Attachments.isLoading);
    dom.sendBtn.disabled = !state.isStreaming && (!configured() || hasLoadingFiles || hasFailedAttachments || (!hasText && !hasReadyFiles));
    dom.sendBtn.classList.toggle('is-stopping', state.isStreaming);
    const label = state.isStreaming ? '停止生成' : (hasFailedAttachments ? '请先移除失败附件' : (hasLoadingFiles ? '附件读取中' : '发送'));
    dom.sendBtn.title = label;
    dom.sendBtn.setAttribute('aria-label', state.isStreaming ? '停止生成' : '发送');
    dom.sendBtn.dataset.tooltip = label;
  }

  function updateThinkingToggleBtn() {
    const enabled = conversationShowThinking();
    dom.thinkingToggleBtn.classList.toggle('active', enabled);
    dom.thinkingToggleBtn.title = enabled ? '隐藏思考过程' : '显示思考过程';
    dom.thinkingToggleBtn.setAttribute('aria-label', enabled ? '隐藏思考过程' : '显示思考过程');
    dom.thinkingToggleBtn.dataset.tooltip = enabled ? '隐藏思考过程' : '显示思考过程';
  }

  function updateContextToggleBtn() {
    const enabled = conversationIncludeContext();
    dom.contextToggleBtn.classList.toggle('active', enabled);
    const label = enabled ? '携带上文' : '不带上文';
    dom.contextToggleBtn.title = label;
    dom.contextToggleBtn.setAttribute('aria-label', label);
    dom.contextToggleBtn.dataset.tooltip = label;
  }

  function updateImageGenerateBtn() {
    const promptText = dom.imagePrompt.value.trim();
    const canvas = state.imageCanvasMode ? currentImageCanvas() : null;
    const canvasSelectionReady = !!canvas?.nodes?.length && selectedCanvasNodes(canvas).some(node => node.output && isRenderableImageOutput(node.output));
    const canvasPlanReview = canvas?.planStatus === 'review';
    dom.imageGenerateBtn.disabled = canvasPlanReview || ((!promptText && !canvasSelectionReady) || state.isGeneratingImage);
    const hasRefs = imageReferenceList().length > 0;
    const generateLabel = state.imageCanvasMode ? '生成画布节点' : hasRefs ? '编辑图片' : '生成图片';
    dom.imageGenerateBtn.title = generateLabel;
    dom.imageGenerateBtn.setAttribute('aria-label', generateLabel);
    dom.imageGenerateBtn.dataset.tooltip = generateLabel;
    dom.imageOptimizeBtn.disabled = !dom.imagePrompt.value.trim() || state.isOptimizingImagePrompt || state.isGeneratingImage;
    dom.imageOptimizeBtn.title = state.isOptimizingImagePrompt ? '正在优化提示词' : '优化提示词';
    dom.imageOptimizeBtn.setAttribute('aria-label', state.isOptimizingImagePrompt ? '正在优化提示词' : '优化提示词');
    dom.imageOptimizeBtn.dataset.tooltip = state.isOptimizingImagePrompt ? '正在优化提示词' : '优化提示词';
    dom.imageOptimizeBtn.classList.toggle('active', state.isOptimizingImagePrompt);
    dom.imageCanvasToggleBtn?.classList.toggle('active', state.imageCanvasMode);
    if (dom.imageCanvasToggleBtn) {
      const canvasAllowed = canUseImageCanvas();
      dom.imageCanvasToggleBtn.disabled = !canvasAllowed;
      dom.imageCanvasToggleBtn.title = canvasAllowed ? '无限画布' : '移动端暂不支持无限画布';
      dom.imageCanvasToggleBtn.dataset.tooltip = dom.imageCanvasToggleBtn.title;
    }
  }

  function currentConversationTokenTotals() {
    const conv = currentConv();
    const totals = { input: 0, output: 0, total: 0, count: 0 };
    if (!conv?.messages?.length) return totals;
    conv.messages.forEach(msg => {
      const usage = OwnChatStream.normalizeUsage(msg.usage);
      const tokens = msg.tokens || estimateMessageTokens(msg);
      if (msg.role === 'assistant' && usage?.output != null) totals.output += usage.output;
      else if (msg.role === 'user') totals.input += tokens;
      else if (msg.role === 'assistant') totals.output += tokens;
      else totals.input += tokens;
      totals.count += 1;
    });
    totals.total = totals.input + totals.output;
    return totals;
  }

  function updateConversationTokenSummary() {
    const conv = currentConv();
    if (state.mode !== 'chat') {
      dom.convTokenSummary.classList.add('hidden');
      dom.convTokenSummary.innerHTML = '';
      return;
    }
    const totals = currentConversationTokenTotals();
    if (!totals.count) {
      dom.convTokenSummary.classList.add('hidden');
      dom.convTokenSummary.innerHTML = '';
      return;
    }
    const contextLimit = Number.isFinite(Number(conv?.contextLimit)) ? Number(conv.contextLimit) : DEFAULT_CONTEXT_LIMIT;
    let summaryText = '';
    let summaryClass = '';
    let summaryTitle = '这是携带上文裁剪额度，不代表模型可输出长度';
    const usedText = formatTokenCount(totals.total);
    if (contextLimit === 0) {
      summaryClass = 'conv-token-unlimited';
      summaryText = `上文已用 ${usedText}，当前不裁剪`;
      summaryTitle = '携带上文不裁剪，不代表模型可输出无限长度';
    } else {
      const remaining = contextLimit - totals.total;
      const ratio = contextLimit > 0 ? remaining / contextLimit : 1;
      summaryClass = remaining < 0 ? 'conv-token-over' : ratio <= 0.1 ? 'conv-token-warn' : '';
      summaryText = remaining < 0
        ? `上文已用 ${usedText}，已超出 ${formatTokenCount(Math.abs(remaining))}，本轮会裁剪`
        : `上文已用 ${usedText}，再增加 ${formatTokenCount(remaining)} 会裁剪`;
    }
    dom.convTokenSummary.classList.remove('hidden');
    dom.convTokenSummary.innerHTML = `
      <div class="conv-token-summary-inner">
        <span class="${summaryClass}" title="${summaryTitle}">${summaryText}</span>
      </div>
    `;
  }

  function conversationContextExceeded(conv = currentConv()) {
    const contextLimit = Number.isFinite(Number(conv?.contextLimit)) ? Number(conv.contextLimit) : DEFAULT_CONTEXT_LIMIT;
    if (!conv?.messages?.length || contextLimit === 0) return false;
    return currentConversationTokenTotals().total > contextLimit;
  }

  function ensureModeConfigured(mode, opts = {}) {
    if (mode === 'chat' && !configured()) {
      showSettings('chat');
      if (opts.toast !== false) showToast('请先完成对话配置');
      return false;
    }
    if (isImageModeLike(mode) && !imageConfigured()) {
      showSettings('image');
      if (opts.toast !== false) showToast('请先完成绘画配置');
      return false;
    }
    return true;
  }

  function imageReferenceList(refs = state.imageRefs) {
    return ImageCore.imageReferenceList(refs, MAX_IMAGE_REFS);
  }

  function setImageReferences(refs) {
    state.imageRefs = imageReferenceList(refs);
  }

  function imageReferencePayload(refs) {
    return ImageCore.imageReferencePayload(refs, MAX_IMAGE_REFS);
  }

  function effectiveImageRequestModel() {
    return state.imageMapModel ? imageMapEndpoint()?.model : state.imageModel;
  }

  function sanitizeImageParams(params = {}) {
    const next = ImageCore.sanitizeImageParamsForModel(effectiveImageRequestModel(), Object.assign({}, DEFAULT_IMAGE_PARAMS, params || {}));
    const count = Math.round(Number(next.count));
    next.count = Number.isFinite(count) ? Math.min(MAX_IMAGE_COUNT, Math.max(1, count)) : 1;
    return next;
  }

  function sanitizeCurrentImageParams(params = imageParamsForCurrentJob()) {
    return sanitizeImageParams(params);
  }

  function imageParamsForCurrentJob() {
    const job = currentImageJob();
    return sanitizeImageParams(job?.params || DEFAULT_IMAGE_PARAMS);
  }

  function syncImageBackgroundSupport() {
    if (!dom.imageBackground) return;
    const model = effectiveImageRequestModel();
    const transparentOption = Array.from(dom.imageBackground.options).find(opt => opt.value === 'transparent');
    const transparentSupported = ImageCore.imageBackgroundSupported(model, 'transparent');
    if (transparentOption) transparentOption.disabled = !transparentSupported;
    if (!transparentSupported && dom.imageBackground.value === 'transparent') {
      dom.imageBackground.value = 'auto';
    }
    if (dom.imageBackground.value === 'transparent' && dom.imageFormat.value === 'jpeg') {
      dom.imageFormat.value = 'png';
    }
    const hintText = `${model || '当前绘画模型'} 不支持透明背景，已自动改用 auto。`;
    dom.imageBackground.title = transparentSupported ? '背景' : hintText;
    if (transparentSupported) dom.imageBackground.removeAttribute('aria-describedby');
    else dom.imageBackground.setAttribute('aria-describedby', 'image-background-hint');
    if (dom.imageBackgroundHint) dom.imageBackgroundHint.classList.toggle('hidden', transparentSupported);
    if (dom.imageBackgroundHint) dom.imageBackgroundHint.textContent = hintText;
  }

  function renderImageRefPreview() {
    const refs = imageReferenceList();
    setImageReferences(refs);
    if (!refs.length) {
      dom.imageRefPreview.classList.add('hidden');
      dom.imageRefPreview.innerHTML = '';
      return;
    }
    dom.imageRefPreview.classList.remove('hidden');
    dom.imageRefPreview.innerHTML = refs.map((ref, index) => `
      <div class="image-ref-card" data-index="${index}">
        <img src="${esc(ref.base64)}" alt="${esc(ref.name || '参考图')}">
        <div class="image-ref-info">
          <div class="image-ref-name">${esc(ref.name || `参考图 ${index + 1}`)}</div>
          <div class="image-ref-hint">${index + 1}/${MAX_IMAGE_REFS} · 将基于参考图编辑</div>
        </div>
        <button class="image-ref-remove" type="button" title="移除参考图">&times;</button>
      </div>
    `).join('');
  }

  function moveModelDropdown() {
    const target = isImageModeLike() ? dom.imageModelSlot : dom.chatModelSlot;
    if (target && dom.modelDropdown.parentElement !== target) target.appendChild(dom.modelDropdown);
  }

  function resetSidebarBulkMode() {
    state.sidebarBulkMode = false;
    state.sidebarSelectedIds.clear();
    state.sidebarVisibleIds = [];
  }

  function switchMode(mode) {
    if (mode === 'canvas') mode = 'image';
    pauseActivePolls();
    if (state.mode !== mode) resetSidebarBulkMode();
    state.mode = mode;
    const imageLike = isImageModeLike(mode);
    if (!imageLike || !canUseImageCanvas()) state.imageCanvasMode = false;
    if (!state.imageCanvasMode) document.body.classList.remove('image-canvas-open');
    dom.modeChatBtn.parentElement.classList.toggle('is-image', mode === 'image');
    dom.modeChatBtn.classList.toggle('active', mode === 'chat');
    dom.modeImageBtn.classList.toggle('active', mode === 'image');
    updateModeA11y(mode);
    dom.messages.classList.toggle('hidden', mode !== 'chat');
    dom.welcome.classList.toggle('hidden', mode !== 'chat' || !!currentConv()?.messages.length);
    dom.inputArea.classList.toggle('hidden', mode !== 'chat');
    updateConversationTokenSummary();
    dom.imageWorkspace.classList.toggle('hidden', !imageLike);
    dom.imageWorkspace.classList.toggle('canvas-mode', imageLike && state.imageCanvasMode);
    dom.imageInputArea.classList.toggle('hidden', mode !== 'image' || state.imageCanvasMode);
    moveModelDropdown();
    closeModelDropdown();
    updateModelBadge();
    updateSidebar();
    if (mode === 'chat') {
      syncConvParams();
      resumeStreamPollIfNeeded();
      dom.userInput.focus();
    } else {
      syncImageParams();
      renderImageWorkspace();
      if (state.imageJobs.some(job => job.status === 'generating')) {
        startImageProgressTimer();
        requestAnimationFrame(updateImageProgressElapsed);
      }
      if (mode === 'image' && !state.imageCanvasMode) scrollImageWorkspaceToBottom(false);
      updateImageGenerateBtn();
      if (mode === 'image' && !state.imageCanvasMode) dom.imagePrompt.focus();
      recoverImageFromSession();
    }
    document.documentElement.removeAttribute('data-boot-mode');
    document.documentElement.removeAttribute('data-boot-empty-chat');
    persist();
  }

  function toggleSidebar() {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    dom.sidebar.classList.toggle('collapsed', state.sidebarCollapsed);
    if (isMobile()) {
      dom.sidebarBackdrop.classList.toggle('hidden', state.sidebarCollapsed);
    }
    persist([KEYS.sidebarCollapsed]);
  }

  // ===== Clipboard =====
  function copyText(text) {
    UiUtils.copyText(text, () => showToast('已复制到剪贴板'), () => showToast('复制失败，请手动复制'));
  }

  function messageTextContent(msg) {
    return ChatRenderer.messageTextContent(msg);
  }

  function copyableMessageText(msg) {
    return ChatRenderer.copyableMessageText(msg);
  }

  function copyableMessagePlainText(msg) {
    return ChatRenderer.copyableMessagePlainText(msg);
  }

  function closeCopyMenus() {
    UiUtils.closeCopyMenus(dom.messages);
  }

  function showToast(msg) {
    $('toast-el')?.remove();
    const el = document.createElement('div');
    el.id = 'toast-el'; el.className = 'toast'; el.textContent = msg;
    dom.main.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }

  function downloadJson(filename, data) {
    UiUtils.downloadJson(filename, data);
  }

  function settingsStateSnapshot() {
    return {
      chatEndpoints: JSON.parse(JSON.stringify(state.chatEndpoints || [])),
      currentChatEndpointId: state.currentChatEndpointId,
      imageEndpoints: JSON.parse(JSON.stringify(state.imageEndpoints || [])),
      currentImageEndpointId: state.currentImageEndpointId,
      imageMapModel: state.imageMapModel,
      imagePromptModel: state.imagePromptModel,
    };
  }

  function restoreSettingsSnapshot() {
    if (!state.settingsSnapshot) return;
    state.chatEndpoints = JSON.parse(JSON.stringify(state.settingsSnapshot.chatEndpoints || []));
    state.currentChatEndpointId = state.settingsSnapshot.currentChatEndpointId;
    state.imageEndpoints = JSON.parse(JSON.stringify(state.settingsSnapshot.imageEndpoints || []));
    state.currentImageEndpointId = state.settingsSnapshot.currentImageEndpointId;
    state.imageMapModel = state.settingsSnapshot.imageMapModel || '';
    state.imagePromptModel = state.settingsSnapshot.imagePromptModel || '';
    state.settingsSnapshot = null;
    syncLegacyFromEndpoints();
    persist([
      KEYS.chatEndpoints,
      KEYS.currentChatEndpointId,
      KEYS.baseUrl,
      KEYS.apiKey,
      KEYS.model,
      KEYS.modelsCache,
      KEYS.imageEndpoints,
      KEYS.currentImageEndpointId,
      KEYS.imageBaseUrl,
      KEYS.imageApiKey,
      KEYS.imageModel,
      KEYS.imageModelsCache,
      KEYS.imageMapModel,
      KEYS.imagePromptModel,
    ]);
  }

  function appConfigSnapshot(includeSecrets = false) {
    const exportEndpoints = endpoints => endpoints.map(endpoint => ({
      id: endpoint.id,
      name: endpoint.name,
      baseUrl: endpoint.baseUrl,
      apiKey: includeSecrets ? endpoint.apiKey : '',
      model: endpoint.model,
      models: endpoint.models || [],
    }));
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      mode: state.mode,
      chat: {
        baseUrl: state.baseUrl,
        apiKey: includeSecrets ? state.apiKey : '',
        model: state.model,
        models: state.modelsCache,
        currentEndpointId: state.currentChatEndpointId,
        endpoints: exportEndpoints(state.chatEndpoints),
      },
      image: {
        baseUrl: state.imageBaseUrl,
        apiKey: includeSecrets ? state.imageApiKey : '',
        model: state.imageModel,
        mapModel: state.imageMapModel,
        promptModel: state.imagePromptModel,
        models: state.imageModelsCache,
        currentEndpointId: state.currentImageEndpointId,
        endpoints: exportEndpoints(state.imageEndpoints),
        defaults: state.imageDefaults,
      },
    };
  }

  // ===== Retry =====
  function cloneMessage(msg) {
    return JSON.parse(JSON.stringify(msg));
  }

  function retryMessage(index) {
    if (state.isStreaming) return;
    const conv = currentConv();
    if (!conv) return;
    const msg = conv.messages[index];
    let userMsg;
    let includeContext = conversationIncludeContext(conv);
    if (msg.role === 'user') {
      userMsg = cloneMessage(msg);
      includeContext = msg.includeContext !== false;
      conv.messages = conv.messages.slice(0, index);
    } else {
      const prev = conv.messages[index - 1];
      if (prev && prev.role === 'user') {
        userMsg = cloneMessage(prev);
        includeContext = prev.includeContext !== false;
        conv.messages = conv.messages.slice(0, index - 1);
      }
      else return;
    }
    userMsg.includeContext = includeContext;
    persist(); renderMessages(); sendMsg(messageTextContent(userMsg), { includeContext, userMessage: userMsg });
  }

  function renderMessages() {
    const conv = currentConv();
    updateModelBadge();
    if (!conv || conv.messages.length === 0) {
      dom.messages.innerHTML = '';
      dom.messages.classList.remove('has-messages');
      dom.welcome.classList.remove('hidden');
      updateConversationTokenSummary();
      return;
    }

    dom.welcome.classList.add('hidden');
    dom.messages.classList.add('has-messages');
    updateConversationTokenSummary();
    dom.messages.innerHTML = ChatRenderer.renderMessages(conv, {
      showThinking: conversationShowThinking(conv),
      icons: {
        person: Icons.person,
        aiAvatar: Icons.aiAvatar,
        copy: Icons.copy,
        edit: Icons.edit,
        refresh: Icons.refresh,
      },
    });

    StreamUi.scrollToBottom(dom.messages);
  }

  function addTyping() {
    return StreamUi.addTyping(dom.messages, dom.welcome, updateConversationTokenSummary, Icons.aiAvatar);
  }

  function removeTyping() { StreamUi.removeTyping(document); }

  function addStreamMsg() {
    return StreamUi.addStreamMsg(dom.messages, Icons.aiAvatar);
  }

  function updateStream(el, text) {
    StreamUi.updateStream(dom.messages, el, text);
  }

  function renderStreamContent(streamEls, content, opts = {}) {
    StreamUi.renderStreamContent(dom.messages, streamEls, content, opts);
  }

  function showThinkingContent(streamEls, reasoningContent, opts = {}) {
    StreamUi.showThinkingContent(dom.messages, streamEls, reasoningContent, opts);
  }

  function updateThinkingStream(streamEls, reasoningContent, reasoningStartTime, streamStartTime, conv = currentConv()) {
    StreamUi.updateThinkingStream(dom.messages, streamEls, reasoningContent, reasoningStartTime, streamStartTime, conversationShowThinking(conv));
  }

  function finishThinkingStream(streamEls, reasoningStartTime, streamStartTime, endedAt = Date.now(), reasoningContent = '') {
    return StreamUi.finishThinkingStream(streamEls, reasoningStartTime, streamStartTime, endedAt, reasoningContent);
  }

  function hideEmptyThinkingStream(streamEls) {
    StreamUi.hideEmptyThinkingStream(streamEls);
  }

  function applyThinkingDoneLabel(streamEls, thinkingMs, reasoningContent = '') {
    StreamUi.applyThinkingDoneLabel(streamEls, thinkingMs, reasoningContent);
  }

  // ===== Model Dropdown =====
  function renderModelDropdown() {
    const models = isImageModeLike()
      ? mergeUnique([state.imageModel], state.imageModelsCache, DEFAULT_IMAGE_MODELS)
      : mergeUnique([conversationModel()], chatEndpointForConversation()?.models || [], state.modelsCache);
    const current = isImageModeLike() ? state.imageModel : conversationModel();
    dom.modelDropdownList.innerHTML = `
      <div class="model-dropdown-header">选择模型</div>
      <div class="model-dropdown-scroll">
        ${models.map(m => `
          <div class="model-option ${m === current ? 'active' : ''}" data-model="${esc(m)}">${esc(m)}</div>
        `).join('')}
      </div>
    `;
  }

  function openModelDropdown() {
    if (!ensureModeConfigured(state.mode)) return;
    renderModelDropdown();
    dom.modelDropdownList.classList.remove('hidden');
  }

  function closeModelDropdown() {
    dom.modelDropdownList.classList.add('hidden');
  }

  // ===== Fetch Models =====
  async function fetchModels(baseUrl, apiKey) {
    try {
      const url = requestUrl(baseUrl, '/models');
      const resp = await apiFetch(url, { headers: { 'Authorization': `Bearer ${apiKey}` } });
      if (!resp.ok) throw httpError(resp.status, `HTTP ${resp.status}`, url);
      const data = await resp.json();
      return (data.data || []).map(m => m.id).sort();
    } catch (e) {
      throw e;
    }
  }

  function endpointModels(kind = 'chat') {
    const endpoint = kind === 'image' ? currentImageEndpoint() : currentChatEndpoint();
    return mergeUnique(endpoint?.model ? [endpoint.model] : [], endpoint?.models || [], kind === 'image' ? DEFAULT_IMAGE_MODELS : []);
  }

  function populateSelectFromCache(selectEl, opts = {}) {
    const endpoint = opts.image ? currentImageEndpoint() : currentChatEndpoint();
    const models = endpointModels(opts.image ? 'image' : 'chat');
    const current = endpoint?.model || '';
    selectEl.innerHTML = '';
    if (models.length === 0) {
      selectEl.innerHTML = '<option value="">-- 点击刷新按钮获取模型 --</option>';
      return;
    }
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === current) opt.selected = true;
      selectEl.appendChild(opt);
    });
  }

  function renderEndpointSelect(kind = 'chat') {
    const isImage = kind === 'image';
    const list = endpointList(kind);
    const selectEl = isImage ? dom.cfgImageEndpointSelect : dom.cfgChatEndpointSelect;
    const nameEl = isImage ? dom.cfgImageEndpointName : dom.cfgChatEndpointName;
    const deleteBtn = isImage ? dom.cfgDeleteImageEndpoint : dom.cfgDeleteChatEndpoint;
    const current = ensureEndpoint(kind);
    selectEl.innerHTML = list.map((endpoint, index) => {
      const label = endpoint.name || endpointLabel(kind, index);
      const model = endpoint.model ? ` · ${endpoint.model}` : '';
      return `<option value="${esc(endpoint.id)}">${esc(label + model)}</option>`;
    }).join('');
    selectEl.value = current.id;
    nameEl.value = current.name || '';
    deleteBtn.disabled = list.length <= 1;
  }

  function refreshEndpointForm(kind = 'chat') {
    const isImage = kind === 'image';
    const endpoint = ensureEndpoint(kind);
    renderEndpointSelect(kind);
    if (isImage) {
      dom.cfgImageBaseUrl.value = endpoint.baseUrl || '';
      dom.cfgImageApiKey.value = endpoint.apiKey || '';
      populateSelectFromCache(dom.cfgImageModelSelect, { image: true });
      dom.cfgImageModelSelect.value = endpoint.model || '';
      dom.cfgImageModelManual.value = '';
      dom.cfgImageModelManual.placeholder = endpoint.model
        ? `手动填写模型，当前 ${endpoint.model}`
        : '手动填写适配 OpenAI Image 协议的模型';
      return;
    }
    dom.cfgBaseUrl.value = endpoint.baseUrl || '';
    dom.cfgApiKey.value = endpoint.apiKey || '';
    populateSelectFromCache(dom.cfgModelSelect);
    dom.cfgModelSelect.value = endpoint.model || '';
    dom.cfgModelManual.value = '';
    dom.cfgModelManual.placeholder = `手动填写模型，当前 ${endpoint.model || '未配置'}`;
  }

  function captureEndpointForm(kind = 'chat', opts = {}) {
    const isImage = kind === 'image';
    const name = (isImage ? dom.cfgImageEndpointName.value : dom.cfgChatEndpointName.value).trim();
    const baseUrl = (isImage ? dom.cfgImageBaseUrl.value : dom.cfgBaseUrl.value).trim();
    const apiKey = (isImage ? dom.cfgImageApiKey.value : dom.cfgApiKey.value).trim();
    const modelManual = (isImage ? dom.cfgImageModelManual.value : dom.cfgModelManual.value).trim();
    const modelSelect = isImage ? dom.cfgImageModelSelect.value : dom.cfgModelSelect.value;
    const model = modelManual || modelSelect;
    const previous = ensureEndpoint(kind);
    const models = mergeUnique(model ? [model] : [], previous.models || [], endpointModelDefaults(kind));
    const normalizedBaseUrl = opts.normalize === false ? baseUrl : (baseUrl ? normalizeUrl(baseUrl) : '');
    const fallbackChat = currentChatEndpoint();
    const hasBaseUrl = isImage && opts.allowFallback ? !!(normalizedBaseUrl || fallbackChat?.baseUrl) : !!normalizedBaseUrl;
    const hasApiKey = isImage && opts.allowFallback ? !!(apiKey || fallbackChat?.apiKey) : !!apiKey;
    if (opts.requireComplete && (!hasBaseUrl || !hasApiKey || !model)) {
      throw new Error(isImage ? '绘画配置需要同时填写 Base URL、API Key 和模型' : '对话配置需要同时填写 Base URL、API Key 和模型');
    }
    updateEndpoint(kind, {
      name: name || previous.name || endpointLabel(kind, endpointList(kind).indexOf(previous)),
      baseUrl: normalizedBaseUrl,
      apiKey,
      model,
      models,
    });
    return ensureEndpoint(kind);
  }

  function populateImageMapModelSelect() {
    const current = parseMapModelRef(state.imageMapModel);
    dom.cfgImageMapModelSelect.innerHTML = '<option value="">关闭映射，使用绘画模型</option>';
    mergeUnique([conversationModel(), state.model], allChatModels(), current.source === 'chat' ? [current.model] : []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = `chat:${m}`;
      opt.textContent = `${m} · 对话`;
      if (opt.value === current.value) opt.selected = true;
      dom.cfgImageMapModelSelect.appendChild(opt);
    });
    mergeUnique([state.imageModel], allImageModels(), DEFAULT_IMAGE_MODELS, current.source === 'image' ? [current.model] : []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = `image:${m}`;
      opt.textContent = `${m} · 绘画`;
      if (opt.value === current.value) opt.selected = true;
      dom.cfgImageMapModelSelect.appendChild(opt);
    });
  }

  function populateImagePromptModelSelect() {
    const current = parsePromptModelRef(state.imagePromptModel);
    dom.cfgImagePromptModelSelect.innerHTML = '<option value="">关闭提示词优化</option>';
    mergeUnique([conversationModel(), state.model], allChatModels(), current.source === 'chat' ? [current.model] : []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = `chat:${m}`;
      opt.textContent = `${m} · 对话`;
      if (opt.value === current.value) opt.selected = true;
      dom.cfgImagePromptModelSelect.appendChild(opt);
    });
    mergeUnique([state.imageModel], allImageModels(), DEFAULT_IMAGE_MODELS, current.source === 'image' ? [current.model] : []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = `image:${m}`;
      opt.textContent = `${m} · 绘画`;
      if (opt.value === current.value) opt.selected = true;
      dom.cfgImagePromptModelSelect.appendChild(opt);
    });
  }

  async function refreshModelsForSelect(baseUrl, apiKey, selectEl, refreshBtn, opts = {}) {
    const effectiveBaseUrl = opts.image ? (baseUrl || currentChatEndpoint()?.baseUrl || '') : baseUrl;
    const effectiveApiKey = opts.image ? (apiKey || currentChatEndpoint()?.apiKey || '') : apiKey;
    if (!effectiveBaseUrl || !effectiveApiKey) {
      alert('请先填写 Base URL 和 API Key');
      return;
    }
    refreshBtn.disabled = true;
    selectEl.innerHTML = '<option value="">加载中...</option>';
    try {
      const models = await fetchModels(effectiveBaseUrl, effectiveApiKey);
      const kind = opts.image ? 'image' : 'chat';
      const endpoint = ensureEndpoint(kind);
      endpoint.models = mergeUnique(endpoint.model ? [endpoint.model] : [], opts.image ? DEFAULT_IMAGE_MODELS : [], models);
      syncLegacyFromEndpoints();
      persist();
      populateSelectFromCache(selectEl, opts);
      selectEl.value = endpoint.model || models[0] || '';
    } catch (e) {
      selectEl.innerHTML = '<option value="">-- 获取失败 --</option>';
      alert(`获取模型列表失败: ${e.message}${e.diagnostics ? `\n\n${e.diagnostics}` : ''}`);
    } finally {
      refreshBtn.disabled = false;
    }
  }

  function mergeUnique(...lists) {
    return Array.from(new Set(lists.flat().filter(Boolean)));
  }

  // ===== Send Message =====
  async function sendMsg(userContent, opts = {}) {
    if (!ensureModeConfigured('chat')) return;
    const conv = currentConv();
    if (!conv) return;
    const chatEndpoint = chatEndpointForConversation(conv);
    const chatModel = ensureConversationModel(conv);
    if (!chatModel) {
      showSettings('chat');
      showToast('请先选择对话模型');
      return;
    }
    const retryUserMsg = opts.userMessage ? cloneMessage(opts.userMessage) : null;
    if (!retryUserMsg && state.pendingFiles.some(Attachments.isLoading)) {
      showToast('附件还在读取中，请稍后发送');
      updateSendBtn();
      return;
    }
    if (!retryUserMsg && state.pendingFiles.some(Attachments.hasError)) {
      showToast('请先移除失败附件后再发送');
      updateSendBtn();
      return;
    }

    const inputTokens = retryUserMsg?.tokens || estimateTokens(userContent);
    const includeContext = opts.includeContext ?? conversationIncludeContext(conv);

    // Build user message content (plain text or multimodal)
    const files = state.pendingFiles.filter(Attachments.isReady);
    if (!retryUserMsg && !userContent.trim() && files.length === 0) return;
    let userMsgData;
    if (retryUserMsg) {
      userMsgData = retryUserMsg;
      userMsgData.includeContext = includeContext;
      userMsgData.timestamp = Date.now();
    } else if (files.length > 0) {
      const fileIssues = Attachments.validateReadyFiles(files);
      if (fileIssues.length) {
        showToast(fileIssues[0]);
        updateSendBtn();
        return;
      }
      userMsgData = Attachments.messageFromReadyFiles(userContent, files, { tokens: inputTokens, timestamp: Date.now(), includeContext });
    } else {
      userMsgData = { role: 'user', content: userContent, tokens: inputTokens, timestamp: Date.now(), includeContext };
    }
    conv.messages.push(userMsgData);
    if (includeContext && conversationContextExceeded(conv)) {
      showToast('携带上文已超出上限，本次将自动裁剪旧消息');
    }

    renderMessages();
    const userMessageSaved = await persistDurable([KEYS.conversations, KEYS.currentConvId]);
    if (userMessageSaved.failed) {
      conv.messages.pop();
      renderMessages();
      showToast('附件保存失败，未发送');
      updateSendBtn();
      return;
    }

    // Build API messages with context window trimming
    const sourceMessages = contextMessagesForRequest(conv, userMsgData, includeContext);
    const rawApiMessages = sourceMessages.map(m => ({
      role: m.role,
      content: m.content,
      files: m.files,
    }));
    const apiMessages = trimContextMessages(rawApiMessages, conv.systemPrompt?.trim() || null, conv.contextLimit);
    const requestInputTokens = apiMessagesTokenCount(apiMessages);

    // Clear pending files only after a normal send. Regeneration reuses the old
    // message attachments and should not discard the user's current draft files.
    if (!retryUserMsg) {
      state.pendingFiles = [];
      renderFilePreview();
    }

    state.isStreaming = true;
    state.streamingConvId = conv.id;
    requestChatWakeLock();
    updateSendBtn();

    // Write stream session metadata
    await writeStreamSession({ convId: conv.id, model: chatModel, requestInputTokens, includeContext, startTime: Date.now() });

    addTyping();

    // Add a placeholder streaming message to conv.messages for crash recovery
    const streamPlaceholder = { role: 'assistant', content: '', tokens: 0, model: chatModel, requestInputTokens, streaming: true };
    conv.messages.push(streamPlaceholder);
    const streamMsgIdx = conv.messages.length - 1;
    persist([KEYS.conversations, KEYS.currentConvId]);

    // Build request params for the Service Worker to make the ONLY API call
    const reqBody = buildChatRequestBody(conv, chatModel, apiMessages);
    const streamUrl = requestUrl(chatEndpoint.baseUrl, '/chat/completions');
    const swAvailable = navigator.serviceWorker?.controller;

    if (swAvailable) {
      // === SW proxy mode: SW makes the only fetch, page reads from IndexedDB ===
      navigator.serviceWorker.controller.postMessage({
        type: 'start-stream',
        ownerId: state.appClientId,
        url: streamUrl,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${chatEndpoint.apiKey}` },
        body: JSON.stringify(reqBody),
        convId: conv.id,
        model: chatModel,
        requestInputTokens,
        includeContext,
      });

      // Set up abort via SW message
      state.chatAbortController = { abort: () => {
        navigator.serviceWorker.controller.postMessage({ type: 'stop-stream', ownerId: state.appClientId });
      }};

      removeTyping();
      state.streamEls = addStreamMsg();
      const streamEls = state.streamEls;
      const streamProgress = StreamSessionPoller.createProgressState();

      // Poll IndexedDB for stream progress (every 100ms)
      state.chatPollTimer = setInterval(async () => {
        const session = await getStreamSession();
        if (!session) return;
        if (session.convId && session.convId !== conv.id) return;

        const progress = StreamSessionPoller.applyProgress(streamProgress, session);
        const content = progress.content;
        const reasoning = progress.reasoning;
        const usage = progress.usage;
        if (conversationShowThinking(conv) && reasoning) streamEls.waiting?.classList.add('hidden');

        updateThinkingStream(streamEls, reasoning, streamProgress.reasoningStartTime, streamProgress.streamStartTime, conv);

        // Update content
        if (progress.contentChanged) {
          streamEls.waiting?.classList.toggle('hidden', !!(content.trim() || (conversationShowThinking(conv) && reasoning)));
          if (conv.messages[streamMsgIdx]?.streaming) {
            conv.messages[streamMsgIdx].content = content;
            conv.messages[streamMsgIdx].tokens = usageOutputTokens(usage, estimateTokens(content));
            if (usage) conv.messages[streamMsgIdx].usage = usage;
            if (reasoning) conv.messages[streamMsgIdx].reasoningContent = reasoning;
            if (streamProgress.firstTokenTime !== null) conv.messages[streamMsgIdx].firstTokenMs = streamProgress.firstTokenTime;
            const reasoningTimeMs = StreamSessionPoller.reasoningTimeMs(streamProgress);
            if (reasoningTimeMs !== null) conv.messages[streamMsgIdx].reasoningTimeMs = reasoningTimeMs;
          }
          updateConversationTokenSummary();
          renderStreamContent(streamEls, content, { hideWaiting: false });
        }

        // Collapse thinking block when reasoning is done and content starts
        if (conversationShowThinking(conv) && reasoning && content) {
          finishThinkingStream(streamEls, streamProgress.reasoningStartTime, streamProgress.streamStartTime, streamProgress.reasoningEndTime, reasoning);
        } else if (content && !reasoning) {
          hideEmptyThinkingStream(streamEls);
        }

        // Handle stream completion
        if (StreamSessionPoller.isTerminalSession(session)) {
          clearInterval(state.chatPollTimer);
          state.chatPollTimer = null;

          const finalSession = await getStableStreamSession(session);
          const finalContent = finalSession.assistantContent || content;
          const finalReasoning = finalSession.reasoningContent || reasoning;
          const finalUsage = OwnChatStream.normalizeUsage(finalSession.usage) || usage;
          const estimatedOutputTokens = estimateTokens(finalContent);
          const outputTokens = usageOutputTokens(finalUsage, estimatedOutputTokens);
          const outputTimeMs = StreamSessionPoller.outputTimeMs(streamProgress, finalSession);
          let msgData;

          if (finalSession.status === 'error') {
            const detail = finalSession.error ? `\n\n\`\`\`text\n${finalSession.error}\n\`\`\`` : '';
            msgData = { role: 'assistant', content: `**错误**: 请求失败${detail}`, tokens: 0, model: chatModel };
          } else if (finalSession.status === 'stopped') {
            const stoppedContent = finalContent.trim()
              ? `${finalContent}\n\n_已停止生成_`
              : '**已停止生成**';
            msgData = { role: 'assistant', content: stoppedContent, tokens: outputTokens, model: chatModel };
            if (finalUsage) msgData.usage = finalUsage;
            if (streamProgress.firstTokenTime !== null) msgData.firstTokenMs = streamProgress.firstTokenTime;
            if (finalReasoning) msgData.reasoningContent = finalReasoning;
            if (Number.isFinite(outputTimeMs)) msgData.outputTimeMs = outputTimeMs;
          } else {
            msgData = { role: 'assistant', content: finalContent, tokens: outputTokens, model: chatModel };
            if (finalUsage) msgData.usage = finalUsage;
            if (streamProgress.firstTokenTime !== null) msgData.firstTokenMs = streamProgress.firstTokenTime;
            if (Number.isFinite(outputTimeMs)) msgData.outputTimeMs = outputTimeMs;
            if (finalReasoning) {
              msgData.reasoningContent = finalReasoning;
              msgData.reasoningTimeMs = StreamSessionPoller.reasoningTimeMs(streamProgress);
            }
          }
          // Replace placeholder
          if (conv.messages[streamMsgIdx]?.streaming) {
            conv.messages[streamMsgIdx] = msgData;
          } else {
            conv.messages.push(msgData);
          }

          if (conv.messages.filter(m => m.role === 'user').length === 1) {
            const firstUserMsg = conv.messages.find(m => m.role === 'user');
            const titleText = typeof firstUserMsg?.content === 'string' ? firstUserMsg.content : '';
            conv.title = titleText.slice(0, 30) + (titleText.length > 30 ? '...' : '');
          }

          persist([KEYS.conversations, KEYS.currentConvId]);
          updateModelBadge();
          updateSidebar();

          $('stream-el')?.remove();
          renderMessages();

          state.isStreaming = false;
          state.streamingConvId = null;
          state.chatAbortController = null;
          releaseChatWakeLock();
          dom.userInput.focus();
          updateSendBtn();
          clearStreamSession();
        }
      }, 100);

    } else {
      // === Fallback: no SW, use direct fetch ===
      const controller = new AbortController();
      state.chatAbortController = controller;
      let assistantContent = '';
      let reasoningContent = '';
      let apiStreamState = OwnChatStream.createStreamState();
      let apiReasoningContent = '';
      let tagReasoningContent = '';
      let firstTokenTime = null;
      let outputStartTime = null;
      let reasoningStartTime = null;
      let reasoningEndTime = null;
      let streamUsage = null;
      const streamStartTime = Date.now();

      try {
        let resp = await apiFetch(streamUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${chatEndpoint.apiKey}` },
          body: JSON.stringify(reqBody),
          signal: controller.signal,
        });

        if (!resp.ok) {
          let errText = await resp.text().catch(() => '');
          if (/stream_options|include_usage/i.test(errText)) {
            const fallbackBody = OwnChatStream.removeStreamOptions(reqBody);
            resp = await apiFetch(streamUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${chatEndpoint.apiKey}` },
              body: JSON.stringify(fallbackBody),
              signal: controller.signal,
            });
            if (!resp.ok) errText = await resp.text().catch(() => errText);
          }
          if (!resp.ok) {
            let err = null;
            try { err = errText ? JSON.parse(errText) : null; } catch { /* keep text */ }
            if (!err) err = await resp.json().catch(() => ({ error: { message: errText || `HTTP ${resp.status}` } }));
            throw httpError(resp.status, err.error?.message || errText || `HTTP ${resp.status}`, streamUrl);
          }
        }

        removeTyping();
        state.streamEls = addStreamMsg();
        const streamEls = state.streamEls;
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastStreamPersist = 0;

        const processStreamLine = (line) => {
          try {
            const json = OwnChatStream.parseSseLine(line);
            if (!json) return;
            const parsed = OwnChatStream.parseChatStreamEvent(json);
            apiStreamState = OwnChatStream.applyStreamDelta(apiStreamState, parsed);
            if (apiStreamState.usage) streamUsage = apiStreamState.usage;
            const reasoningDelta = parsed.reasoning;
            const contentDelta = parsed.content;

            if (reasoningDelta) {
              if (reasoningStartTime === null) reasoningStartTime = Date.now();
              apiReasoningContent = apiStreamState.reasoning;
              reasoningContent = [apiReasoningContent, tagReasoningContent].filter(Boolean).join('\n\n');
              updateThinkingStream(streamEls, reasoningContent, reasoningStartTime, streamStartTime, conv);
            }

            if (contentDelta) {
              if (firstTokenTime === null) {
                firstTokenTime = Date.now() - streamStartTime;
                outputStartTime = Date.now();
              }
              assistantContent += contentDelta;
              const splitContent = splitThinkTags(assistantContent);
              tagReasoningContent = splitContent.reasoning;
              reasoningContent = [apiReasoningContent, tagReasoningContent].filter(Boolean).join('\n\n');
              if (reasoningContent) {
                if (reasoningStartTime === null) reasoningStartTime = Date.now();
                if (reasoningEndTime === null) updateThinkingStream(streamEls, reasoningContent, reasoningStartTime, streamStartTime, conv);
              }
              if (reasoningContent && !splitContent.openThink && reasoningEndTime === null) {
                reasoningEndTime = Date.now();
                finishThinkingStream(streamEls, reasoningStartTime, streamStartTime, reasoningEndTime, reasoningContent);
              } else if (!reasoningContent) {
                hideEmptyThinkingStream(streamEls);
              }
              if (conversationShowThinking(conv)) streamEls.waiting?.classList.add('hidden');
              else streamEls.waiting?.classList.toggle('hidden', !!splitContent.content.trim());
              updateStream(streamEls.contentMd, splitContent.content);
              if (conv.messages[streamMsgIdx]?.streaming) {
                conv.messages[streamMsgIdx].content = splitContent.content;
                conv.messages[streamMsgIdx].tokens = usageOutputTokens(streamUsage, estimateTokens(splitContent.content));
                if (streamUsage) conv.messages[streamMsgIdx].usage = streamUsage;
                if (reasoningContent) conv.messages[streamMsgIdx].reasoningContent = reasoningContent;
                if (firstTokenTime !== null) conv.messages[streamMsgIdx].firstTokenMs = firstTokenTime;
                if (reasoningEndTime !== null) conv.messages[streamMsgIdx].reasoningTimeMs = reasoningEndTime - (reasoningStartTime || streamStartTime);
              }
              updateConversationTokenSummary();
              const now = Date.now();
              if (now - lastStreamPersist > 2000) {
                lastStreamPersist = now;
                persist([KEYS.conversations]);
              }
            }
          } catch { /* skip */ }
        };

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
        }

        const finalSplitContent = splitThinkTags(assistantContent);
        if (finalSplitContent.reasoning) {
          tagReasoningContent = finalSplitContent.reasoning;
          reasoningContent = [apiReasoningContent, tagReasoningContent].filter(Boolean).join('\n\n');
        }
        const finalContent = finalSplitContent.content;
        const outputTokens = usageOutputTokens(streamUsage, estimateTokens(finalContent));
        const outputEndTime = Date.now();
        const outputTimeMs = outputStartTime ? outputEndTime - outputStartTime : null;
        const msgData = { role: 'assistant', content: finalContent, tokens: outputTokens, model: chatModel };
        if (streamUsage) msgData.usage = streamUsage;
        if (firstTokenTime !== null) msgData.firstTokenMs = firstTokenTime;
        if (outputTimeMs !== null) msgData.outputTimeMs = outputTimeMs;
        if (reasoningContent) {
          msgData.reasoningContent = reasoningContent;
          msgData.reasoningTimeMs = reasoningEndTime ? reasoningEndTime - (reasoningStartTime || streamStartTime) : null;
        }
        if (conv.messages[streamMsgIdx]?.streaming) {
          conv.messages[streamMsgIdx] = msgData;
        } else {
          conv.messages.push(msgData);
        }

        if (conv.messages.filter(m => m.role === 'user').length === 1) {
          conv.title = userContent.slice(0, 30) + (userContent.length > 30 ? '...' : '');
        }

        persist([KEYS.conversations, KEYS.currentConvId]);
        updateModelBadge();
        updateSidebar();

        $('stream-el')?.remove();
        renderMessages();

      } catch (e) {
        removeTyping();
        $('stream-el')?.remove();
        if (e?.name === 'AbortError') {
          const stoppedContent = assistantContent.trim()
            ? `${assistantContent}\n\n_已停止生成_`
            : '**已停止生成**';
          const stoppedMsg = { role: 'assistant', content: stoppedContent, tokens: estimateTokens(assistantContent), model: chatModel };
          if (firstTokenTime !== null) stoppedMsg.firstTokenMs = firstTokenTime;
          if (outputStartTime) stoppedMsg.outputTimeMs = Date.now() - outputStartTime;
          if (reasoningContent) stoppedMsg.reasoningContent = reasoningContent;
          if (conv.messages[streamMsgIdx]?.streaming) conv.messages[streamMsgIdx] = stoppedMsg;
          else conv.messages.push(stoppedMsg);
        } else {
          const detail = e.diagnostics ? `\n\n\`\`\`text\n${e.diagnostics}\n\`\`\`` : '';
          const errMsg = { role: 'assistant', content: `**错误**: ${e.message}${detail}`, tokens: 0, model: chatModel };
          if (conv.messages[streamMsgIdx]?.streaming) conv.messages[streamMsgIdx] = errMsg;
          else conv.messages.push(errMsg);
        }
        renderMessages();
      } finally {
        state.isStreaming = false;
        state.streamingConvId = null;
        state.chatAbortController = null;
        releaseChatWakeLock();
        // Only update UI if we're still viewing this conversation
        if (currentConv()?.id === conv.id) {
          dom.userInput.focus();
          updateSendBtn();
        } else {
          updateInputState();
        }
        clearStreamSession();
      }
    }
  }

  // ===== Auto-resize =====
  function textareaHeightLimit(el) {
    if (el === dom.imagePrompt) return isMobile() ? 180 : 260;
    return isMobile() ? 190 : 260;
  }

  function autoResize() {
    if (dom.userInput.dataset.manualHeight === 'true') return;
    dom.userInput.style.height = 'auto';
    dom.userInput.style.height = Math.min(dom.userInput.scrollHeight, textareaHeightLimit(dom.userInput)) + 'px';
  }

  function setupTextareaResizeHandles() {
    document.querySelectorAll('.textarea-resize-handle[data-resize-target]').forEach(handle => {
      const target = $(handle.dataset.resizeTarget);
      if (!target) return;
      const startDrag = event => {
        const point = event.touches?.[0] || event;
        state.textareaResize = {
          handle,
          target,
          startY: point.clientY,
          startHeight: target.getBoundingClientRect().height,
        };
        target.dataset.manualHeight = 'true';
        handle.classList.add('is-dragging');
        event.preventDefault();
      };
      handle.addEventListener('mousedown', startDrag);
      handle.addEventListener('touchstart', startDrag, { passive: false });
    });
    const moveDrag = event => {
      const drag = state.textareaResize;
      if (!drag) return;
      const point = event.touches?.[0] || event;
      const delta = drag.startY - point.clientY;
      const minHeight = drag.target === dom.imagePrompt ? 72 : 56;
      const maxHeight = textareaHeightLimit(drag.target);
      const nextHeight = Math.max(minHeight, Math.min(maxHeight, drag.startHeight + delta));
      drag.target.style.height = `${nextHeight}px`;
      event.preventDefault();
    };
    const endDrag = () => {
      if (!state.textareaResize) return;
      state.textareaResize.handle.classList.remove('is-dragging');
      state.textareaResize = null;
    };
    window.addEventListener('mousemove', moveDrag);
    window.addEventListener('touchmove', moveDrag, { passive: false });
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('touchend', endDrag);
    window.addEventListener('touchcancel', endDrag);
  }

  // ===== Settings Modal =====
  function showSettings(tab = state.mode) {
    if (!state.settingsSnapshot) state.settingsSnapshot = settingsStateSnapshot();
    syncLegacyFromEndpoints();
    refreshEndpointForm('chat');
    refreshEndpointForm('image');
    populateImageMapModelSelect();
    dom.cfgImageMapModelSelect.value = parseMapModelRef(state.imageMapModel).value;
    dom.cfgImageMapModelManual.value = '';
    const mapRef = parseMapModelRef(state.imageMapModel);
    dom.cfgImageMapModelManual.placeholder = mapRef.model ? `当前 ${mapRef.source}:${mapRef.model}` : '可选，如 chat:gpt-5.5 或 image:gpt-image-2';
    populateImagePromptModelSelect();
    dom.cfgImagePromptModelSelect.value = parsePromptModelRef(state.imagePromptModel).value;
    dom.cfgImagePromptModelManual.value = '';
    const promptRef = parsePromptModelRef(state.imagePromptModel);
    dom.cfgImagePromptModelManual.placeholder = promptRef.model ? `当前 ${promptRef.source}:${promptRef.model}` : '可选，如 chat:gpt-5.5 或 image:gpt-image-2';
    switchSettingsTab(tab === 'image' ? 'image' : 'chat');
    showModal(dom.settingsModal);
    updateStorageStats();
  }

  function hideSettings() {
    restoreSettingsSnapshot();
    hideModal(dom.settingsModal);
  }

  function closeSettingsAfterSave() {
    state.settingsSnapshot = null;
    hideModal(dom.settingsModal);
  }

  function showModal(modal) {
    Dialogs.show(modal);
  }

  function hideModal(modal) {
    Dialogs.hide(modal);
  }

  function openModal() {
    return Dialogs.open([dom.configImportModal, dom.settingsModal]);
  }

  function trapModalFocus(event, modal) {
    Dialogs.trapFocus(event, modal);
  }

  function handleModalKeydown(event) {
    const modal = openModal();
    if (!modal) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (modal === dom.configImportModal) hideConfigImportConfirm();
      else hideSettings();
      return;
    }
    if (event.key === 'Tab') trapModalFocus(event, modal);
  }

  function switchSettingsTab(tab) {
    const isImage = tab === 'image';
    dom.settingsChatTab.classList.toggle('active', !isImage);
    dom.settingsImageTab.classList.toggle('active', isImage);
    dom.settingsChatPanel.classList.toggle('hidden', isImage);
    dom.settingsImagePanel.classList.toggle('hidden', !isImage);
  }

  // ===== Setup Overlay =====
  function hideSetup() {
    dom.setupOverlay.classList.add('hidden');
  }

  async function loadImageHistory() {
    state.isImageHistoryLoading = true;
    if (isImageModeLike()) updateSidebar();
    try {
      const imageSession = await getImageSession();
      state.imageJobs = await imageDbGetAllJobs();
      const changedJobs = [];
      state.imageJobs.forEach(job => {
        if (isImageCanvasJob(job)) {
          normalizeCanvasJob(job);
          let changedCanvas = false;
          job.nodes.forEach(node => {
            if (node.status === 'generating') {
              node.status = 'error';
              node.error = '上次节点生成因页面刷新或关闭而中断，请重新生成分支。';
              changedCanvas = true;
            }
          });
          if (job.status === 'generating') {
            job.status = 'done';
            changedCanvas = true;
          }
          if (changedCanvas) changedJobs.push(job);
          return;
        }
        if (job.status === 'generating') {
          const sessionMatches = imageSession?.jobId === job.id;
          const sessionStatus = sessionMatches ? imageSession.status : '';
          if (sessionMatches && ['complete', 'error', 'stopped'].includes(sessionStatus)) {
            applyRecoveredImageSession(job, imageSession);
            changedJobs.push(job);
            return;
          }
          if (sessionMatches && ['connecting', 'streaming'].includes(sessionStatus)) {
            ensureImageJobReplies(job);
            return;
          }
          job.status = 'error';
          job.error = '上次生成因页面刷新或关闭而中断，请点击“重绘”重新生成。';
          job.durationMs = job.startedAt ? Date.now() - job.startedAt : job.durationMs;
          const reply = currentImageActiveReply(job);
          if (reply?.status === 'generating') {
            reply.status = 'error';
            reply.error = job.error;
            reply.durationMs = job.durationMs;
          }
          changedJobs.push(job);
        }
        const replies = ensureImageJobReplies(job);
        replies.forEach(reply => {
          if (reply?.status !== 'generating') return;
          const sessionMatches = imageSession?.jobId === job.id;
          if (sessionMatches && ['connecting', 'streaming'].includes(imageSession.status)) return;
          reply.status = job.status === 'cancelled' ? 'cancelled' : 'error';
          reply.error = job.error || '上次生成因页面刷新或关闭而中断，请点击“重绘”重新生成。';
          reply.durationMs = reply.startedAt ? Date.now() - reply.startedAt : reply.durationMs;
          if (job.status === 'generating') {
            job.status = reply.status;
            job.error = reply.error;
            job.durationMs = reply.durationMs;
          }
          if (!changedJobs.includes(job)) changedJobs.push(job);
        });
      });
      if (changedJobs.length) {
        await Promise.allSettled(changedJobs.map(job => imageDbPutJob(job)));
        persist();
      }
      if (state.currentImageJobId && !state.imageJobs.some(j => j.id === state.currentImageJobId)) {
        state.currentImageJobId = state.imageJobs[0]?.id || null;
        persist();
      }
      const currentImageJob = state.imageJobs.find(j => j.id === state.currentImageJobId);
      state.imageCanvasMode = canUseImageCanvas() && state.imageCanvasMode && isImageCanvasJob(currentImageJob);
    } finally {
      state.isImageHistoryLoading = false;
      if (isImageModeLike()) {
        updateSidebar();
        syncImageParams();
        renderImageWorkspace();
        scrollImageWorkspaceToBottom(false);
      }
    }
  }

  // ===== Image Mode =====
  function syncImageParams() {
    const params = imageParamsForCurrentJob();
    dom.imageSize.value = params.size;
    dom.imageQuality.value = params.quality;
    dom.imageCount.value = String(params.count || 1);
    dom.imageFormat.value = params.outputFormat;
    dom.imageBackground.value = params.background;
    syncImageBackgroundSupport();
  }

  function saveImageParams() {
    const params = sanitizeCurrentImageParams({
      size: dom.imageSize.value,
      quality: dom.imageQuality.value,
      count: dom.imageCount.value,
      outputFormat: dom.imageFormat.value,
      background: dom.imageBackground.value,
    });
    const job = currentImageJob();
    if (job) {
      job.params = Object.assign({}, job.params || {}, params);
      imageDbPutJob(job);
    } else {
      state.imageDefaults = Object.assign({}, params);
    }
    dom.imageCount.value = String(params.count || 1);
    dom.imageFormat.value = params.outputFormat;
    dom.imageBackground.value = params.background;
    syncImageBackgroundSupport();
    persist();
    return params;
  }

  function currentImageJob() {
    return state.imageJobs.find(j => j.id === state.currentImageJobId);
  }

  function isImageCanvasJob(job) {
    return job?.kind === 'canvas';
  }

  function currentImageCanvas() {
    const job = currentImageJob();
    return isImageCanvasJob(job) ? job : null;
  }

  function imageCanvasId(prefix = 'canvas') {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }

  function normalizeCanvasJob(job) {
    if (!isImageCanvasJob(job)) return null;
    if (!Array.isArray(job.nodes)) job.nodes = [];
    if (!Array.isArray(job.edges)) job.edges = [];
    const nodeIds = new Set(job.nodes.map(node => node.id));
    const edgeIds = new Set();
    job.edges = job.edges.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to);
    job.edges.forEach(edge => {
      if (!edge.id || edgeIds.has(edge.id)) edge.id = imageCanvasId('edge');
      edgeIds.add(edge.id);
    });
    if (state.imageCanvasSelectedEdgeId && !job.edges.some(edge => edge.id === state.imageCanvasSelectedEdgeId)) {
      state.imageCanvasSelectedEdgeId = null;
    }
    job.nodes.forEach(node => {
      const edgeSourceIds = job.edges
        .filter(edge => edge.to === node.id)
        .map(edge => edge.from);
      node.sourceNodeIds = [...new Set([...(node.sourceNodeIds || []), ...edgeSourceIds].filter(id => nodeIds.has(id) && id !== node.id))];
      if (node.parentNodeId && !nodeIds.has(node.parentNodeId)) node.parentNodeId = node.sourceNodeIds[0] || null;
    });
    if (!Array.isArray(job.selectedNodeIds)) job.selectedNodeIds = [];
    if (!Array.isArray(job.history)) job.history = [];
    if (!Array.isArray(job.future)) job.future = [];
    job.viewport = Object.assign({ x: 320, y: 80, zoom: 1 }, job.viewport || {});
    job.params = sanitizeImageParams(job.params || DEFAULT_IMAGE_PARAMS);
    return job;
  }

  function createImageCanvasJob(prompt, params) {
    const now = Date.now();
    return normalizeCanvasJob({
      id: now.toString(),
      kind: 'canvas',
      title: prompt.trim().slice(0, 30) + (prompt.trim().length > 30 ? '...' : ''),
      prompt: prompt.trim(),
      model: state.imageModel,
      mapModel: state.imageMapModel,
      createdAt: now,
      updatedAt: now,
      params: Object.assign({}, params),
      nodes: [],
      edges: [],
      selectedNodeIds: [],
      history: [],
      future: [],
      viewport: { x: 320, y: 80, zoom: 1 },
      status: 'done',
    });
  }

  function imageCanvasSnapshot(canvas = currentImageCanvas()) {
    if (!canvas) return null;
    return {
      nodes: JSON.parse(JSON.stringify(canvas.nodes || [])),
      edges: JSON.parse(JSON.stringify(canvas.edges || [])),
      selectedNodeIds: [...(canvas.selectedNodeIds || [])],
      viewport: Object.assign({}, canvas.viewport || {}),
      planStatus: canvas.planStatus || '',
      plan: canvas.plan ? JSON.parse(JSON.stringify(canvas.plan)) : null,
      planProgress: canvas.planProgress ? JSON.parse(JSON.stringify(canvas.planProgress)) : null,
      prompt: canvas.prompt || '',
      title: canvas.title || '',
    };
  }

  function persistedImageCanvas(canvas) {
    if (!canvas) return canvas;
    const copy = Object.assign({}, canvas);
    copy.nodes = canvas.nodes || [];
    copy.edges = canvas.edges || [];
    copy.selectedNodeIds = canvas.selectedNodeIds || [];
    copy.history = [];
    copy.future = [];
    return copy;
  }

  function applyImageCanvasSnapshot(canvas, snapshot) {
    if (!canvas || !snapshot) return;
    canvas.nodes = JSON.parse(JSON.stringify(snapshot.nodes || []));
    canvas.edges = JSON.parse(JSON.stringify(snapshot.edges || []));
    canvas.selectedNodeIds = [...(snapshot.selectedNodeIds || [])];
    canvas.viewport = Object.assign({ x: 320, y: 80, zoom: 1 }, snapshot.viewport || {});
    canvas.planStatus = snapshot.planStatus || 'done';
    canvas.plan = snapshot.plan ? JSON.parse(JSON.stringify(snapshot.plan)) : null;
    canvas.planProgress = snapshot.planProgress ? JSON.parse(JSON.stringify(snapshot.planProgress)) : null;
    canvas.prompt = snapshot.prompt || canvas.prompt || '';
    canvas.title = snapshot.title || canvas.title || '无限画布';
    if (canvas.planStatus === 'review' && !(canvas.nodes || []).some(node => node.status === 'review') && !canvas.plan?.tasks?.length) canvas.planStatus = 'done';
  }

  function pushImageCanvasHistory(canvas = currentImageCanvas()) {
    normalizeCanvasJob(canvas);
    if (!canvas) return;
    const snapshot = imageCanvasSnapshot(canvas);
    const last = canvas.history[canvas.history.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(snapshot)) return;
    canvas.history.push(snapshot);
    if (canvas.history.length > 40) canvas.history.shift();
    canvas.future = [];
  }

  function undoImageCanvas(canvas = currentImageCanvas()) {
    normalizeCanvasJob(canvas);
    if (!canvas?.history?.length) return;
    canvas.future.push(imageCanvasSnapshot(canvas));
    applyImageCanvasSnapshot(canvas, canvas.history.pop());
    saveImageCanvas(canvas);
    renderImageWorkspace();
    updateImageGenerateBtn();
  }

  function redoImageCanvas(canvas = currentImageCanvas()) {
    normalizeCanvasJob(canvas);
    if (!canvas?.future?.length) return;
    canvas.history.push(imageCanvasSnapshot(canvas));
    applyImageCanvasSnapshot(canvas, canvas.future.pop());
    saveImageCanvas(canvas);
    renderImageWorkspace();
    updateImageGenerateBtn();
  }

  function exportImageCanvas(canvas = currentImageCanvas()) {
    if (!canvas) return;
    const name = `${(canvas.title || 'image-canvas').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 48) || 'image-canvas'}.json`;
    downloadJson(name, {
      version: 1,
      exportedAt: new Date().toISOString(),
      kind: 'image-canvas',
      canvas: imageCanvasSnapshot(canvas),
      params: canvas.params || DEFAULT_IMAGE_PARAMS,
      model: canvas.model || state.imageModel,
      mapModel: canvas.mapModel || state.imageMapModel,
    });
  }

  async function importImageCanvasFile(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const snapshot = payload?.canvas || payload;
      if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) throw new Error('文件不是有效画布 JSON');
      const params = sanitizeCurrentImageParams(Object.assign({}, saveImageParams(), payload.params || {}));
      const canvas = createImageCanvasJob(snapshot.title || snapshot.prompt || file.name.replace(/\.json$/i, '') || '导入画布', params);
      applyImageCanvasSnapshot(canvas, snapshot);
      canvas.params = params;
      canvas.model = payload.model || state.imageModel;
      canvas.mapModel = payload.mapModel || state.imageMapModel;
      canvas.history = [];
      canvas.future = [];
      state.imageJobs.unshift(canvas);
      state.currentImageJobId = canvas.id;
      state.imageCanvasMode = true;
      imageDbPutJob(persistedImageCanvas(canvas));
      persist([KEYS.currentImageJobId, KEYS.imageCanvasMode]);
      updateSidebar();
      renderImageWorkspace();
      showToast('画布已导入');
    } catch (error) {
      showToast(String(error?.message || error || '导入画布失败'));
    }
  }

  function selectedCanvasNodes(canvas = currentImageCanvas()) {
    normalizeCanvasJob(canvas);
    const selected = new Set(canvas?.selectedNodeIds || []);
    return (canvas?.nodes || []).filter(node => selected.has(node.id));
  }

  function canvasNodeImageSource(node, params = DEFAULT_IMAGE_PARAMS) {
    if (!node?.output || !isRenderableImageOutput(node.output)) return '';
    return dataUrlForImage(node.output, node.params?.outputFormat || params.outputFormat || 'png');
  }

  async function canvasNodeImageSourceForRequest(node, params = DEFAULT_IMAGE_PARAMS, signal = null) {
    if (!node?.output || !isRenderableImageOutput(node.output)) return '';
    if (node.output.b64) return canvasNodeImageSource(node, params);
    if (!node.output.url) return '';
    const resp = await apiFetch(node.output.url, { signal });
    if (!resp.ok) throw new Error(`参考图下载失败：HTTP ${resp.status}`);
    const blob = await resp.blob();
    if (!blob.size) throw new Error('参考图下载结果为空，无法用于合并');
    node.output.b64 = String(await ImageCore.blobToDataUrl(blob)).split(',')[1] || '';
    node.output.format = normalizeImageFormat(blob.type || node.output.format || params.outputFormat || 'png');
    node.output.bytes = blob.size;
    node.output.urlCachedAt = Date.now();
    node.output.urlCachedDirty = true;
    return canvasNodeImageSource(node, params);
  }

  function canvasNodeRefs(nodes) {
    return (nodes || [])
      .filter(node => node?.output && isRenderableImageOutput(node.output))
      .map(node => ({
        name: `${node.title || 'canvas-node'}.png`,
        type: `image/${node.output.format || node.params?.outputFormat || 'png'}`,
        base64: canvasNodeImageSource(node, node.params || DEFAULT_IMAGE_PARAMS),
      }));
  }

  async function canvasNodeRefsForRequest(nodes, signal = null) {
    const refs = [];
    for (const node of nodes || []) {
      if (!node?.output || !isRenderableImageOutput(node.output)) continue;
      const base64 = await canvasNodeImageSourceForRequest(node, node.params || DEFAULT_IMAGE_PARAMS, signal);
      if (!base64 || !/^data:image\/[^;]+;base64,/i.test(base64) || !base64.split(',')[1]) continue;
      refs.push({
        name: `${node.title || 'canvas-node'}.png`,
        type: `image/${node.output.format || node.params?.outputFormat || 'png'}`,
        base64,
      });
    }
    return refs;
  }

  function imageCanvasNodeInputRefs(node) {
    return imageReferencePayload(node?.inputImages || node?.referenceImages || []);
  }

  function imageCanvasReferenceSourceNodes(canvas, node) {
    const ids = new Set(node?.sourceNodeIds || []);
    return (canvas?.nodes || []).filter(item => ids.has(item.id) && item.operation === 'reference' && item.output && isRenderableImageOutput(item.output));
  }

  function imageCanvasGeneratedSourceNodes(canvas, node) {
    const ids = new Set(node?.sourceNodeIds || []);
    return (canvas?.nodes || []).filter(item => ids.has(item.id) && item.operation !== 'reference' && item.output && isRenderableImageOutput(item.output));
  }

  async function imageCanvasRequestRefs(sourceNodes, inputRefs, signal = null) {
    const refs = [
      ...imageReferencePayload(inputRefs || []),
      ...await canvasNodeRefsForRequest(sourceNodes, signal),
    ].filter(ref => ref?.base64 && /^data:image\/[^;]+;base64,/i.test(ref.base64) && ref.base64.split(',')[1]);
    return refs.slice(0, MAX_IMAGE_REFS);
  }

  function saveImageCanvas(canvas, opts = {}) {
    if (!canvas) return;
    canvas.updatedAt = Date.now();
    imageDbPutJob(persistedImageCanvas(canvas));
    persist([KEYS.currentImageJobId, KEYS.imageCanvasMode]);
    if (opts.sidebar !== false) updateSidebar();
  }

  function imageCanvasOperationLabel(operation) {
    return ({
      plan: '规划',
      root: '主题',
      branch: '分支',
      optimize: '优化',
      merge: '合并',
      variant: '变化',
      reference: '参考',
    })[operation] || '节点';
  }

  function meaningfulImageCanvasTopic(canvas) {
    const generic = new Set(['无限画布', '参考图画布']);
    const prompt = String(canvas?.prompt || '').trim();
    if (prompt && !generic.has(prompt)) return prompt;
    const title = String(canvas?.title || '').trim();
    if (title && !generic.has(title)) return title;
    return '';
  }

  function renderImageCanvasPlannerModal(canvas) {
    if (!state.imageCanvasPlannerOpen) return '';
    const topic = state.imageCanvasPlannerTopic || meaningfulImageCanvasTopic(canvas);
    const refs = imageReferencePayload(state.imageCanvasPlannerRefs || [], 10);
    const refText = refs.length ? `已选择 ${refs.length} 张参考图` : '未选择文件';
    const template = state.imageCanvasPlannerTemplate || 'free';
    const complexity = state.imageCanvasPlannerComplexity || 'standard';
    const templateMeta = {
      free: ['自由拆解', '不套固定结构，由 AI 按主题和参考图自行规划节点。'],
      story: ['故事分镜', '按镜头、场景和情绪变化拆成连续视觉节点。'],
      product: ['产品视觉', '围绕主视觉、场景、材质、细节和商业用途规划节点。'],
      character: ['角色设定', '围绕角色外观、表情、动作、服饰和场景规划节点。'],
    }[template] || ['自由拆解', '不套固定结构，由 AI 按主题和参考图自行规划节点。'];
    return `
      <div class="image-canvas-planner-overlay" role="presentation">
        <div class="image-canvas-planner-backdrop image-canvas-action" data-action="canvas-close-planner"></div>
        <section class="image-canvas-planner-modal" role="dialog" aria-modal="true" aria-label="AI Planner" tabindex="-1">
          <div class="image-canvas-planner-head">
            <div>
              <span>AI PLANNER</span>
              <h2>主题拆解</h2>
            </div>
            <button class="image-canvas-planner-close image-canvas-action" data-action="canvas-close-planner" type="button" title="关闭" data-tooltip="关闭">
              <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>
            </button>
          </div>
          <div class="image-canvas-planner-field">
            <div class="image-canvas-planner-label">
              <label for="image-canvas-planner-topic">创作主题</label>
              <button class="image-canvas-planner-chip image-canvas-action" data-action="canvas-optimize-planner-topic" type="button" title="AI 优化主题" data-tooltip="AI 优化主题">
                <svg viewBox="0 0 24 24"><path d="M12 3l1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8Z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8Z"/></svg>
                AI 优化
              </button>
            </div>
            <textarea id="image-canvas-planner-topic" class="image-canvas-planner-topic" maxlength="800" placeholder="例如：让女孩抱着小猫，樱花街道，温柔光影，二次元风格">${esc(topic)}</textarea>
          </div>
          <div class="image-canvas-planner-grid">
            <label class="image-canvas-planner-select">
              <span>拆解模板</span>
              <select class="image-canvas-planner-template">
                <option value="free" ${template === 'free' ? 'selected' : ''}>自由拆解</option>
                <option value="story" ${template === 'story' ? 'selected' : ''}>故事分镜</option>
                <option value="product" ${template === 'product' ? 'selected' : ''}>产品视觉</option>
                <option value="character" ${template === 'character' ? 'selected' : ''}>角色设定</option>
              </select>
            </label>
            <label class="image-canvas-planner-select">
              <span>复杂度</span>
              <select class="image-canvas-planner-complexity">
                <option value="standard" ${complexity === 'standard' ? 'selected' : ''}>标准</option>
                <option value="simple" ${complexity === 'simple' ? 'selected' : ''}>简单</option>
                <option value="advanced" ${complexity === 'advanced' ? 'selected' : ''}>复杂</option>
              </select>
            </label>
            <label class="image-canvas-planner-ref">
              <span>参考图，可多选</span>
              <div class="image-canvas-planner-file">
                <button class="image-canvas-planner-file-btn image-canvas-action" data-action="canvas-pick-planner-refs" type="button" title="上传参考图" data-tooltip="上传参考图">选择文件</button>
                <span>${esc(refText)}</span>
              </div>
              <small>最多参考 10 张，支持 PNG / JPG / WebP。</small>
            </label>
          </div>
          ${refs.length ? `<div class="image-canvas-planner-ref-list">
            ${refs.map((ref, index) => `
              <div class="image-canvas-planner-ref-card">
                <img src="${esc(ref.base64)}" alt="${esc(ref.name || '参考图')}" draggable="false">
                <button class="image-canvas-action" data-action="canvas-remove-planner-ref" data-ref="${index}" type="button" title="移除参考图" data-tooltip="移除参考图"><svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg></button>
              </div>
            `).join('')}
          </div>` : ''}
          <div class="image-canvas-planner-note">
            <strong>${esc(templateMeta[0])}</strong>
            <p>${esc(templateMeta[1])}</p>
          </div>
          <div class="image-canvas-planner-footer">
            <button class="image-canvas-planner-secondary image-canvas-action" data-action="canvas-close-planner" type="button" title="取消拆解" data-tooltip="取消拆解">取消</button>
            <button class="image-canvas-planner-primary image-canvas-action" data-action="canvas-submit-planner" type="button" title="生成草稿节点" data-tooltip="生成草稿节点" ${state.isGeneratingImage ? 'disabled' : ''}>生成草稿节点</button>
          </div>
        </section>
      </div>
    `;
  }

  function renderImageCanvasEdges(canvas) {
    const nodesById = new Map((canvas.nodes || []).map(node => [node.id, node]));
    const selectedIds = new Set(canvas.selectedNodeIds || []);
    const selectedEdgeId = state.imageCanvasSelectedEdgeId || '';
    const edges = (canvas.edges || []).map((edge, index) => {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      if (!from || !to) return '';
      const fromRect = imageCanvasNodeRect(from);
      const toRect = imageCanvasNodeRect(to);
      const x1 = fromRect.x + fromRect.w;
      const y1 = fromRect.y + fromRect.h / 2;
      const x2 = toRect.x;
      const y2 = toRect.y + toRect.h / 2;
      const mid = Math.max(60, Math.abs(x2 - x1) * .45);
      const d = `M ${x1 + 5000} ${y1 + 5000} C ${x1 + mid + 5000} ${y1 + 5000}, ${x2 - mid + 5000} ${y2 + 5000}, ${x2 + 5000} ${y2 + 5000}`;
      const edgeType = edge.type === 'dependency' && from.output && isRenderableImageOutput(from.output) ? 'reference' : (edge.type || 'branch');
      const selected = edge.id && edge.id === selectedEdgeId;
      const related = selected || selectedIds.has(edge.from) || selectedIds.has(edge.to);
      const edgePathId = `image-canvas-edge-${index}`;
      const label = edgeType === 'merge' ? '合并' : edgeType === 'dependency' ? '依赖' : edgeType === 'reference' ? '参考' : '分支';
      return `
        <g class="image-canvas-edge-group ${related ? 'related' : ''} ${selected ? 'selected' : ''}">
          <path class="image-canvas-edge-hit image-canvas-action" data-action="canvas-select-edge" data-edge="${esc(edge.id || '')}" d="${esc(d)}"></path>
          <path id="${edgePathId}" class="image-canvas-edge ${esc(edgeType)} ${related ? 'related' : ''} ${selected ? 'selected' : ''}" d="${esc(d)}" marker-end="url(#image-canvas-arrow)"></path>
          <text class="image-canvas-edge-label"><textPath href="#${edgePathId}" startOffset="50%">${esc(label)}</textPath></text>
        </g>
      `;
    }).join('');
    return `
      <defs>
        <marker id="image-canvas-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L8,4 L0,8 Z" class="image-canvas-edge-arrow"></path>
        </marker>
      </defs>
      ${edges}
    `;
  }

  function renderImageCanvasNode(canvas, node) {
    const selected = (canvas.selectedNodeIds || []).includes(node.id);
    const connectActive = state.imageCanvasConnectFrom === node.id;
    const connectTarget = !!state.imageCanvasConnectFrom && state.imageCanvasConnectFrom !== node.id;
    const img = canvasNodeImageSource(node, canvas.params);
    const status = node.status === 'generating' ? 'generating' : node.error ? 'error' : 'done';
    const statusLabel = node.status === 'review' ? '待确认' : node.status === 'queued' ? '排队中' : node.status === 'generating' ? '生成中' : formatDateTime(node.createdAt || canvas.createdAt);
    const nodeStateClass = node.error ? 'error' : node.status === 'generating' ? 'generating' : node.status === 'review' ? 'review' : 'done';
    const nodeStateLabel = node.operation === 'reference' ? '参考图' : node.error ? '失败' : node.status === 'generating' ? '生成中' : node.status === 'review' ? '待确认' : '已完成';
    const refSourceCount = imageCanvasReferenceSourceNodes(canvas, node).length;
    const generatedSourceCount = imageCanvasGeneratedSourceNodes(canvas, node).length;
    const inputRefCount = imageCanvasNodeInputRefs(node).length;
    const referenceTotal = refSourceCount + inputRefCount;
    const hasOutput = node.output && isRenderableImageOutput(node.output);
    const media = img
      ? `<img src="${esc(img)}" alt="${esc(node.title || node.prompt || '画布节点')}" draggable="false">`
      : `<div class="image-canvas-node-placeholder">${node.status === 'generating' ? '<div class="image-spinner"></div>' : `<span>${node.status === 'review' ? '任务节点' : '等待生成'}</span>`}</div>`;
    const errorBlock = node.error ? `<div class="image-canvas-node-error">${esc(node.error)}</div>` : '';
    const reviewFields = node.status === 'review' ? `
          <textarea class="image-canvas-node-prompt-input" data-node="${esc(node.id)}" aria-label="节点提示词">${esc(node.prompt || '')}</textarea>
        ` : `
          <div class="image-canvas-node-prompt">${esc(node.prompt || '')}</div>
        `;
    const executeButton = node.status === 'review'
      ? `<button class="image-canvas-node-btn primary image-canvas-action" data-action="canvas-run-node" data-node="${esc(node.id)}" type="button" title="执行" data-tooltip="执行"><svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg></button>`
      : '';
    const nodeActions = `
          <div class="image-canvas-node-actions">
            <button class="image-canvas-node-btn ${connectActive ? 'primary' : ''} image-canvas-action" data-action="canvas-connect-node" data-node="${esc(node.id)}" type="button" title="${connectActive ? '取消连线' : '连线'}" data-tooltip="${connectActive ? '取消连线' : '连线'}"><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/></svg></button>
            ${hasOutput ? `<button class="image-canvas-node-btn image-canvas-action" data-action="canvas-download-node" data-node="${esc(node.id)}" type="button" title="下载" data-tooltip="下载"><svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg></button>` : ''}
            ${hasOutput ? `<button class="image-canvas-node-btn image-canvas-action" data-action="canvas-optimize-node" data-node="${esc(node.id)}" type="button" title="优化" data-tooltip="优化"><svg viewBox="0 0 24 24"><path d="M12 3l1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8Z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8Z"/></svg></button>` : ''}
            <button class="image-canvas-node-btn image-canvas-action" data-action="canvas-branch-node" data-node="${esc(node.id)}" type="button" title="分支" data-tooltip="分支" ${hasOutput ? '' : 'disabled'}><svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M9 6h3a6 6 0 0 1 6 6v3"/><path d="M9 6h9"/></svg></button>
            <button class="image-canvas-node-btn image-canvas-action" data-action="canvas-duplicate-node" data-node="${esc(node.id)}" type="button" title="复制节点" data-tooltip="复制节点"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/></svg></button>
            <button class="image-canvas-node-btn danger image-canvas-action" data-action="canvas-delete-node" data-node="${esc(node.id)}" type="button" title="删除" data-tooltip="删除"><svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 18h10l1-18"/><path d="M10 11v7"/><path d="M14 11v7"/></svg></button>
          </div>
        `;
    return `
      <div class="image-canvas-node operation-${esc(node.operation || 'branch')} ${selected ? 'selected' : ''} ${connectActive ? 'connecting' : ''} ${connectTarget ? 'connect-target' : ''} ${status}" data-node="${esc(node.id)}" style="left:${Number(node.x) || 0}px;top:${Number(node.y) || 0}px">
        <div class="image-canvas-node-head">
          <div class="image-canvas-node-title-wrap">
            ${node.status === 'review'
              ? `<input class="image-canvas-node-title-input" data-node="${esc(node.id)}" value="${esc(node.title || '')}" maxlength="40" aria-label="节点标题">`
              : `<div class="image-canvas-node-title">${esc(node.title || imageCanvasOperationLabel(node.operation))}</div>`}
            <span class="image-canvas-node-status ${esc(nodeStateClass)}">${esc(nodeStateLabel)}</span>
          </div>
          <div class="image-canvas-node-head-actions">
            ${executeButton}
            <button class="image-canvas-node-btn image-canvas-action" data-action="canvas-focus-node" data-node="${esc(node.id)}" type="button" title="定位" data-tooltip="定位"><svg viewBox="0 0 24 24"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/><circle cx="12" cy="12" r="4"/></svg></button>
            ${hasOutput ? `<button class="image-canvas-node-btn image-canvas-action" data-action="canvas-view-node" data-node="${esc(node.id)}" type="button" title="查看" data-tooltip="查看"><svg viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg></button>` : ''}
            ${node.error ? `<button class="image-canvas-node-btn image-canvas-action" data-action="canvas-retry-node" data-node="${esc(node.id)}" type="button" title="重试" data-tooltip="重试"><svg viewBox="0 0 24 24"><path d="M21 2v6h-6"/><path d="M20 11a8 8 0 1 1-2.3-5.7L21 8"/></svg></button>` : ''}
          </div>
        </div>
        ${media}
        <div class="image-canvas-node-body">
          ${reviewFields}
          ${errorBlock}
          <div class="image-canvas-node-meta">
            <span>${esc(imageCanvasOperationLabel(node.operation))}</span>
            <span>${referenceTotal ? `参考图 ${referenceTotal}` : generatedSourceCount ? `上游 ${generatedSourceCount}` : esc(statusLabel)}</span>
          </div>
          ${nodeActions}
        </div>
      </div>
    `;
  }

  function renderImageCanvasSide(canvas) {
    const selected = selectedCanvasNodes(canvas);
    const selectedGenerated = selected.filter(node => node.output && isRenderableImageOutput(node.output));
    const first = selected[0] || null;
    const failedNodes = (canvas.nodes || []).filter(node => node.error || node.status === 'error');
    if (canvas.planStatus === 'review' && canvas.plan) {
      const tasks = Array.isArray(canvas.plan.tasks) ? canvas.plan.tasks : [];
      return `
        <h3>确认任务拆解</h3>
        <p>文本模型已拆分任务。可以修改任务名和提示词，确认后再开始调用生图模型。</p>
        <div class="image-canvas-side-section image-canvas-task-list">
          ${tasks.map((task, index) => `
            <div class="image-canvas-task" data-task="${index}">
              <div class="image-canvas-task-tools">
                <span class="image-canvas-task-index">任务 ${index + 1}</span>
                <button class="btn-secondary image-canvas-action" data-action="canvas-remove-task" data-task="${index}" type="button" title="删除这个拆解任务" data-tooltip="删除这个拆解任务">删除</button>
              </div>
              <input class="image-canvas-task-title" data-task="${index}" value="${esc(task.title || '')}" maxlength="40" aria-label="任务名称">
              <textarea class="image-canvas-task-prompt" data-task="${index}" aria-label="生图提示词">${esc(task.prompt || '')}</textarea>
            </div>
          `).join('')}
        </div>
        <div class="image-canvas-side-section image-canvas-side-actions">
          <button class="btn-secondary image-canvas-action" data-action="canvas-add-task" type="button" title="手动添加一个拆解任务" data-tooltip="手动添加一个拆解任务">添加任务</button>
          <button class="btn-primary image-canvas-action" data-action="canvas-run-plan" type="button" title="确认拆解并开始并行生成" data-tooltip="确认拆解并开始并行生成" ${tasks.length ? '' : 'disabled'}>开始执行</button>
        </div>
      `;
    }
    if (!canvas.nodes.length) {
      return `
        <h3>无限画布</h3>
        <p>输入主题后点击生成，会创建第一个图片节点。之后可以选中节点继续分支、优化或合并。</p>
        <div class="image-canvas-side-section">
          <button class="btn-secondary image-canvas-action" data-action="canvas-new" type="button" title="创建一个新的空白画布" data-tooltip="创建一个新的空白画布">新画布</button>
        </div>
      `;
    }
    return `
      <h3>${selected.length ? `已选 ${selected.length} 个节点` : '未选择节点'}</h3>
      <p>${first ? esc(first.prompt || first.title || '') : '点击画布节点后，可以基于它继续生成分支。按住 Shift 或 Command 可多选节点用于合并。'}</p>
      ${first?.error ? `<div class="image-canvas-side-section"><div class="image-canvas-error-detail">${esc(first.error)}</div></div>` : ''}
      <div class="image-canvas-side-section image-canvas-side-actions">
        <button class="btn-secondary image-canvas-action" data-action="canvas-branch" type="button" title="基于选中节点创建分支任务" data-tooltip="基于选中节点创建分支任务" ${selected.length === 1 ? '' : 'disabled'}>生成分支</button>
        <button class="btn-secondary image-canvas-action" data-action="canvas-optimize" type="button" title="基于选中节点创建优化任务" data-tooltip="基于选中节点创建优化任务" ${selected.length === 1 ? '' : 'disabled'}>优化节点</button>
        <button class="btn-secondary image-canvas-action" data-action="canvas-retry-selected" type="button" title="重试选中的失败节点" data-tooltip="重试选中的失败节点" ${selected.length === 1 && first?.error ? '' : 'disabled'}>重试失败</button>
        <button class="btn-primary image-canvas-action" data-action="canvas-merge" type="button" title="将多个已生成节点融合成新图" data-tooltip="将多个已生成节点融合成新图" ${selectedGenerated.length >= 2 ? '' : 'disabled'}>合并选择</button>
      </div>
      ${failedNodes.length ? `<div class="image-canvas-side-section"><button class="btn-secondary image-canvas-action" data-action="canvas-retry-failed" type="button" title="并行重试全部失败节点" data-tooltip="并行重试全部失败节点">重试全部失败 ${failedNodes.length}</button></div>` : ''}
      <div class="image-canvas-side-section">
        <div class="image-canvas-selection-list">
          ${selected.map(node => `<div class="image-canvas-selection-item">${esc(node.title || node.prompt || node.id)}</div>`).join('') || '<div class="image-canvas-selection-item">暂无选中节点</div>'}
        </div>
      </div>
    `;
  }

  function renderImageCanvasWorkspace() {
    const canvas = normalizeCanvasJob(currentImageCanvas());
    const viewport = canvas?.viewport || { x: 320, y: 80, zoom: 1 };
    const nodeCount = canvas?.nodes?.length || 0;
    const empty = !canvas || !nodeCount;
    const failedCount = (canvas?.nodes || []).filter(node => node.status === 'error' || node.error).length;
    const statusText = canvas?.planStatus === 'planning'
      ? '正在拆分任务'
      : canvas?.planStatus === 'review'
        ? `待确认 · ${canvas.plan?.tasks?.length || 0} 个任务`
        : canvas?.planStatus === 'generating'
          ? `正在生成任务节点 · ${canvas.planProgress?.completed || 0}/${canvas.planProgress?.total || canvas.plan?.tasks?.length || 0} · 并发 ${canvas.planProgress?.maxParallel || MAX_CANVAS_PARALLEL}`
          : `${nodeCount} 个节点${failedCount ? ` · 失败 ${failedCount}` : ''} · 缩放 ${Math.round((viewport.zoom || 1) * 100)}%`;
    const emptyTitle = canvas?.planStatus === 'planning'
      ? '文本模型正在拆分任务'
      : canvas?.planStatus === 'review'
        ? '请确认任务拆解'
        : '从一个主题开始';
    const emptyText = canvas?.planStatus === 'planning'
      ? '主题会先被规划成多个生图任务，完成后会等待人工确认。'
      : canvas?.planStatus === 'review'
        ? '直接在节点里微调任务名称和生图提示词，确认后再开始执行。'
        : '点击顶部智能拆解开始规划。Shift 拖动画布可框选，滚轮缩放，拖动空白区域平移。';
    const doneCount = (canvas?.nodes || []).filter(node => node.output && isRenderableImageOutput(node.output)).length;
    const generatingCount = (canvas?.nodes || []).filter(node => node.status === 'generating').length;
    const queuedCount = (canvas?.nodes || []).filter(node => node.status === 'queued').length;
    const reviewCount = (canvas?.nodes || []).filter(node => node.status === 'review').length;
    const selected = selectedCanvasNodes(canvas);
    const selectedGenerated = selected.filter(node => node.output && isRenderableImageOutput(node.output));
    const title = canvas?.title || canvas?.prompt || '无限画布';
    const selectedText = selected.length ? `已选 ${selected.length}` : '未选择节点';
    const firstSelected = selected[0] || null;
    const failedSelected = selected.find(node => node.error || node.status === 'error');
    const canUndo = !!canvas?.history?.length;
    const canRedo = !!canvas?.future?.length;
    const opStats = (canvas?.nodes || []).reduce((acc, node) => {
      const key = imageCanvasOperationLabel(node.operation);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const failedPreview = (canvas?.nodes || []).find(node => node.error)?.error || '';
    const connectFromNode = state.imageCanvasConnectFrom
      ? (canvas?.nodes || []).find(node => node.id === state.imageCanvasConnectFrom)
      : null;
    const selectedEdge = state.imageCanvasSelectedEdgeId
      ? (canvas?.edges || []).find(edge => edge.id === state.imageCanvasSelectedEdgeId)
      : null;
    const canvasStatusText = connectFromNode
      ? `连线中 · ${connectFromNode.title || connectFromNode.prompt || '起点'} → 点击目标节点`
      : selectedEdge
        ? '已选中参考线 · 可断开这条线'
      : statusText;
    return `
      <div class="image-canvas-shell image-canvas-fullscreen" role="application" aria-label="无限画布工作台">
        <header class="image-canvas-topbar">
          <div class="image-canvas-top-left">
            <div class="image-canvas-brandmark">
              <strong>${esc(title)}</strong>
              <span>${nodeCount} 节点</span>
            </div>
          </div>
          <div class="image-canvas-top-center">
            <button class="image-canvas-pill-btn image-canvas-action" data-action="canvas-plan-topic" type="button" title="智能拆解" data-tooltip="智能拆解" ${state.isGeneratingImage ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24"><path d="M12 3l1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8Z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8Z"/></svg>
              智能拆解
            </button>
            <button class="image-canvas-pill-btn primary image-canvas-action" data-action="canvas-run-review" type="button" title="执行画布" data-tooltip="执行画布" ${reviewCount ? '' : 'disabled'}>
              <svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>
              执行画布
            </button>
            <button class="image-canvas-pill-btn image-canvas-action" data-action="canvas-fit" type="button" title="适配视图" data-tooltip="适配视图" ${nodeCount ? '' : 'disabled'}>
              <svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
              适配视图
            </button>
          </div>
          <div class="image-canvas-top-actions">
            <button class="image-canvas-return-btn image-canvas-action" data-action="canvas-exit" type="button" title="返回绘画模式" data-tooltip="返回绘画模式">
              <svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/><path d="M9 12h12"/></svg>
              返回生成
            </button>
            ${state.isGeneratingImage ? `<button class="image-canvas-icon-btn danger image-canvas-action" data-action="canvas-stop" type="button" title="中断生成" data-tooltip="中断生成"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>` : ''}
            <button class="image-canvas-icon-btn image-canvas-action" data-action="canvas-new" type="button" title="新画布" data-tooltip="新画布"><svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></svg></button>
            <button class="image-canvas-icon-btn image-canvas-action" data-action="canvas-undo" type="button" title="撤销" data-tooltip="撤销" ${canUndo ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-1"/></svg></button>
            <button class="image-canvas-icon-btn image-canvas-action" data-action="canvas-redo" type="button" title="重做" data-tooltip="重做" ${canRedo ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h1"/></svg></button>
            <button class="image-canvas-icon-btn image-canvas-action" data-action="canvas-export" type="button" title="导出画布" data-tooltip="导出画布"><svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg></button>
            <button class="image-canvas-icon-btn image-canvas-action" data-action="canvas-import" type="button" title="导入画布" data-tooltip="导入画布"><svg viewBox="0 0 24 24"><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/></svg></button>
          </div>
        </header>

        <div class="image-canvas-stage ${state.imageCanvasPointer ? 'is-dragging' : ''}" data-role="canvas-stage">
          <div class="image-canvas-plane" style="transform: translate(${Number(viewport.x) || 0}px, ${Number(viewport.y) || 0}px) scale(${Number(viewport.zoom) || 1})">
            <svg class="image-canvas-edges" aria-hidden="true">${canvas ? renderImageCanvasEdges(canvas) : ''}</svg>
            ${canvas ? canvas.nodes.map(node => renderImageCanvasNode(canvas, node)).join('') : ''}
          </div>
          ${empty ? `<div class="image-canvas-empty-state"><div class="image-canvas-empty-panel"><h2>${esc(emptyTitle)}</h2><p>${esc(emptyText)}</p></div></div>` : ''}
        </div>

        <aside class="image-canvas-inspector-panel">
          <section class="image-canvas-panel-card compact">
            <div class="image-canvas-panel-title"><strong>${esc(selectedText)}</strong><span>${nodeCount} 节点</span></div>
            <div class="image-canvas-stat-grid">
              <div><strong>${doneCount}</strong><span>完成</span></div>
              <div><strong>${reviewCount}</strong><span>待确认</span></div>
              <div><strong>${failedCount}</strong><span>失败</span></div>
            </div>
            <div class="image-canvas-op-list">
              ${Object.entries(opStats).map(([label, count]) => `<span>${esc(label)} ${count}</span>`).join('') || '<span>暂无节点</span>'}
            </div>
            ${failedPreview ? `<div class="image-canvas-error-detail compact">${esc(failedPreview)}</div>` : ''}
          </section>
          <section class="image-canvas-panel-card">
            <div class="image-canvas-panel-title"><strong>${esc(firstSelected?.title || '节点详情')}</strong><span>${esc(firstSelected ? imageCanvasOperationLabel(firstSelected.operation) : '未选择')}</span></div>
            <p>${esc(firstSelected?.prompt || '选择节点后，可在节点头部直接查看、优化、分支、重试或删除。按 Shift/Command 点击可多选，Shift 拖动画布可框选。')}</p>
            ${failedSelected?.error ? `<div class="image-canvas-error-detail">${esc(failedSelected.error)}</div>` : ''}
            <div class="image-canvas-panel-actions">
              <button class="btn-secondary image-canvas-action" data-action="canvas-branch" type="button" title="基于选中节点创建分支任务" data-tooltip="基于选中节点创建分支任务" ${selected.length === 1 && selectedGenerated.length === 1 ? '' : 'disabled'}>分支</button>
              <button class="btn-secondary image-canvas-action" data-action="canvas-optimize" type="button" title="基于选中节点创建优化任务" data-tooltip="基于选中节点创建优化任务" ${selected.length === 1 && selectedGenerated.length === 1 ? '' : 'disabled'}>优化</button>
              <button class="btn-secondary image-canvas-action" data-action="canvas-retry-selected" type="button" title="重试选中的失败节点" data-tooltip="重试选中的失败节点" ${failedSelected ? '' : 'disabled'}>重试</button>
              <button class="btn-primary image-canvas-action" data-action="canvas-merge" type="button" title="将多个已生成节点融合成新图" data-tooltip="将多个已生成节点融合成新图" ${selectedGenerated.length >= 2 ? '' : 'disabled'}>合并</button>
              <button class="btn-secondary image-canvas-action" data-action="canvas-focus-selected" type="button" title="把选中节点移动到视图中心" data-tooltip="把选中节点移动到视图中心" ${firstSelected ? '' : 'disabled'}>定位</button>
              <button class="btn-secondary image-canvas-action" data-action="canvas-clear-selection" type="button" title="取消当前选中节点" data-tooltip="取消当前选中节点" ${selected.length ? '' : 'disabled'}>取消选择</button>
              <button class="btn-secondary image-canvas-action" data-action="canvas-copy-prompt" type="button" title="复制选中节点提示词" data-tooltip="复制选中节点提示词" ${firstSelected ? '' : 'disabled'}>复制提示</button>
              <button class="btn-secondary image-canvas-action" data-action="canvas-duplicate-selected" type="button" title="复制选中节点到旁边" data-tooltip="复制选中节点到旁边" ${selected.length ? '' : 'disabled'}>复制节点</button>
              <button class="btn-secondary image-canvas-action" data-action="canvas-download-selected" type="button" title="下载选中节点图片" data-tooltip="下载选中节点图片" ${selectedGenerated.length ? '' : 'disabled'}>下载</button>
              <button class="btn-secondary image-canvas-action" data-action="canvas-variant-selected" type="button" title="为选中节点创建变体任务" data-tooltip="为选中节点创建变体任务" ${selectedGenerated.length ? '' : 'disabled'}>生成变体</button>
            </div>
          </section>
        </aside>

        <div class="image-canvas-commandbar">
          <div class="image-canvas-command-actions">
            <span>${esc(canvasStatusText)}</span>
            <button class="image-canvas-tool-btn image-canvas-action" data-action="canvas-add-ref" type="button" title="添加参考图" data-tooltip="添加参考图"><svg viewBox="0 0 24 24"><path d="M15 8h.01"/><path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="m4 15 4-4a2 2 0 0 1 3 0l5 5"/><path d="m14 14 1-1a2 2 0 0 1 3 0l2 2"/></svg></button>
            <button class="image-canvas-tool-btn image-canvas-action" data-action="canvas-run-review" type="button" title="执行待确认" data-tooltip="执行待确认" ${reviewCount ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>${reviewCount ? `<span>${reviewCount}</span>` : ''}</button>
            <button class="image-canvas-tool-btn image-canvas-action" data-action="canvas-auto-layout" type="button" title="整理节点" data-tooltip="整理节点" ${nodeCount ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M4 7h6"/><path d="M14 7h6"/><path d="M4 17h6"/><path d="M14 17h6"/><path d="M10 7h4"/><path d="M10 17h4"/></svg></button>
            <button class="image-canvas-tool-btn image-canvas-action" data-action="canvas-disconnect-edge" type="button" title="断开选中参考线" data-tooltip="断开选中参考线" ${selectedEdge ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M17 7 7 17"/><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/></svg></button>
            <button class="image-canvas-tool-btn image-canvas-action" data-action="canvas-merge" type="button" title="合并选择" data-tooltip="合并选择" ${selectedGenerated.length >= 2 ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M7 7h4a4 4 0 0 1 4 4v6"/><path d="M7 17h4a4 4 0 0 0 4-4V7"/></svg></button>
            <button class="image-canvas-tool-btn image-canvas-action" data-action="canvas-variant-selected" type="button" title="生成变体" data-tooltip="生成变体" ${selectedGenerated.length ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M12 3l1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8Z"/></svg></button>
          </div>
        </div>
        ${renderImageCanvasPlannerModal(canvas)}
      </div>
    `;
  }

  function setImageCanvasMode(enabled) {
    const nextEnabled = !!enabled && canUseImageCanvas();
    if (nextEnabled && !isImageCanvasJob(currentImageJob())) {
      const topic = dom.imagePrompt?.value?.trim() || '无限画布';
      const canvas = createImageCanvasJob(topic, sanitizeCurrentImageParams(saveImageParams()));
      state.imageJobs.unshift(canvas);
      state.currentImageJobId = canvas.id;
      imageDbPutJob(canvas);
      updateSidebar();
    }
    state.imageCanvasMode = nextEnabled;
    persist([KEYS.currentImageJobId, KEYS.imageCanvasMode]);
    if (dom.imageCanvasToggleBtn) dom.imageCanvasToggleBtn.classList.toggle('active', state.imageCanvasMode);
    renderImageWorkspace();
    updateImageGenerateBtn();
  }

  function canvasViewport(canvas = currentImageCanvas()) {
    normalizeCanvasJob(canvas);
    return canvas?.viewport || { x: 320, y: 80, zoom: 1 };
  }

  function setCanvasViewport(next, opts = {}) {
    const canvas = currentImageCanvas();
    if (!canvas) return;
    const current = canvasViewport(canvas);
    canvas.viewport = {
      x: Number.isFinite(Number(next.x)) ? Number(next.x) : current.x,
      y: Number.isFinite(Number(next.y)) ? Number(next.y) : current.y,
      zoom: Math.min(2.4, Math.max(.28, Number.isFinite(Number(next.zoom)) ? Number(next.zoom) : current.zoom)),
    };
    if (opts.render !== false) renderImageWorkspace();
    if (opts.persist !== false) saveImageCanvas(canvas, { sidebar: false });
  }

  function focusImageCanvasNode(node, zoom = null) {
    const canvas = currentImageCanvas();
    const stage = dom.imageCanvasWorkspace?.querySelector('.image-canvas-stage');
    if (!canvas || !node || !stage) return;
    const rect = stage.getBoundingClientRect();
    const nextZoom = zoom || canvas.viewport?.zoom || 1;
    setCanvasViewport({
      x: rect.width / 2 - ((Number(node.x) || 0) + 118) * nextZoom,
      y: rect.height / 2 - ((Number(node.y) || 0) + 165) * nextZoom,
      zoom: nextZoom,
    });
  }

  function scheduleImageCanvasViewportSave(canvas = currentImageCanvas()) {
    if (!canvas) return;
    clearTimeout(state.imageCanvasViewportSaveTimer);
    state.imageCanvasViewportSaveTimer = setTimeout(() => {
      state.imageCanvasViewportSaveTimer = null;
      saveImageCanvas(canvas, { sidebar: false });
      renderImageWorkspace();
    }, 180);
  }

  function fitImageCanvas() {
    const canvas = currentImageCanvas();
    if (!canvas?.nodes?.length) return;
    const stage = dom.imageCanvasWorkspace?.querySelector('.image-canvas-stage');
    if (!stage) return;
    const minX = Math.min(...canvas.nodes.map(node => Number(node.x) || 0));
    const minY = Math.min(...canvas.nodes.map(node => Number(node.y) || 0));
    const maxX = Math.max(...canvas.nodes.map(node => {
      const rect = imageCanvasNodeRect(node);
      return rect.x + rect.w;
    }));
    const maxY = Math.max(...canvas.nodes.map(node => {
      const rect = imageCanvasNodeRect(node);
      return rect.y + rect.h;
    }));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const zoom = Math.min(1.2, Math.max(.32, Math.min((stage.clientWidth - 80) / width, (stage.clientHeight - 80) / height)));
    setCanvasViewport({ x: 40 - minX * zoom, y: 40 - minY * zoom, zoom });
  }

  function autoLayoutImageCanvas(canvas = currentImageCanvas()) {
    if (!canvas?.nodes?.length) return;
    normalizeCanvasJob(canvas);
    pushImageCanvasHistory(canvas);
    const nodesById = new Map(canvas.nodes.map(node => [node.id, node]));
    const incoming = new Map(canvas.nodes.map(node => [node.id, []]));
    (canvas.edges || []).forEach(edge => {
      if (nodesById.has(edge.from) && nodesById.has(edge.to)) incoming.get(edge.to)?.push(edge.from);
    });
    const depthById = new Map();
    const resolveDepth = (nodeId, stack = new Set()) => {
      if (depthById.has(nodeId)) return depthById.get(nodeId);
      if (stack.has(nodeId)) return 0;
      stack.add(nodeId);
      const parents = incoming.get(nodeId) || [];
      const depth = parents.length ? Math.max(...parents.map(parentId => resolveDepth(parentId, stack) + 1)) : 0;
      stack.delete(nodeId);
      depthById.set(nodeId, depth);
      return depth;
    };
    canvas.nodes.forEach(node => resolveDepth(node.id));
    const columns = new Map();
    canvas.nodes.forEach(node => {
      const depth = depthById.get(node.id) || 0;
      if (!columns.has(depth)) columns.set(depth, []);
      columns.get(depth).push(node);
    });
    [...columns.entries()].sort((a, b) => a[0] - b[0]).forEach(([depth, column]) => {
      column
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .forEach((node, index) => {
          node.x = depth * 320;
          node.y = index * 310;
        });
    });
    saveImageCanvas(canvas, { sidebar: false });
    renderImageWorkspace();
    requestAnimationFrame(fitImageCanvas);
  }

  function nextCanvasNodePosition(canvas, sources = []) {
    if (!canvas.nodes.length || !sources.length) return { x: 0, y: 0 };
    const maxX = Math.max(...sources.map(node => Number(node.x) || 0));
    const avgY = sources.reduce((sum, node) => sum + (Number(node.y) || 0), 0) / sources.length;
    const siblingCount = canvas.edges.filter(edge => sources.some(node => edge.from === node.id)).length;
    return { x: maxX + 320, y: Math.round(avgY + (siblingCount % 4) * 42) };
  }

  function addImageCanvasNode(canvas, { prompt, params, operation, sources = [], inputImages = [] }) {
    const position = nextCanvasNodePosition(canvas, sources);
    const node = {
      id: imageCanvasId('node'),
      title: `${imageCanvasOperationLabel(operation)} · ${prompt.trim().slice(0, 18)}${prompt.trim().length > 18 ? '...' : ''}`,
      prompt: prompt.trim(),
      x: position.x,
      y: position.y,
      params: Object.assign({}, params),
      operation,
      parentNodeId: sources[0]?.id || null,
      sourceNodeIds: sources.map(node => node.id),
      inputImages: imageReferencePayload(inputImages),
      model: state.imageModel,
      mapModel: state.imageMapModel,
      status: 'generating',
      createdAt: Date.now(),
      output: null,
      error: '',
    };
    canvas.nodes.push(node);
    sources.forEach(source => {
      canvas.edges.push({ id: imageCanvasId('edge'), from: source.id, to: node.id, type: operation === 'merge' ? 'merge' : 'branch' });
    });
    state.imageCanvasSelectedEdgeId = null;
    canvas.selectedNodeIds = [node.id];
    return node;
  }

  function addImageCanvasReviewNode(canvas, { prompt, params, operation = 'branch', sources = [], inputImages = [], title = '' }) {
    if (!canvas) return null;
    normalizeCanvasJob(canvas);
    pushImageCanvasHistory(canvas);
    const finalPrompt = String(prompt || defaultCanvasPrompt(operation, sources) || '').trim();
    const position = nextCanvasNodePosition(canvas, sources);
    const node = {
      id: imageCanvasId('node'),
      title: String(title || `${imageCanvasOperationLabel(operation)} · ${finalPrompt.slice(0, 18)}${finalPrompt.length > 18 ? '...' : ''}`).trim(),
      prompt: finalPrompt,
      x: position.x,
      y: position.y,
      params: Object.assign({}, params),
      operation,
      parentNodeId: sources[0]?.id || null,
      sourceNodeIds: sources.map(source => source.id),
      inputImages: imageReferencePayload(inputImages),
      model: state.imageModel,
      mapModel: state.imageMapModel,
      status: 'review',
      createdAt: Date.now(),
      output: null,
      error: '',
    };
    canvas.nodes.push(node);
    sources.forEach(source => {
      canvas.edges.push({ id: imageCanvasId('edge'), from: source.id, to: node.id, type: operation === 'merge' ? 'merge' : 'branch' });
    });
    state.imageCanvasSelectedEdgeId = null;
    canvas.selectedNodeIds = [node.id];
    canvas.planStatus = 'review';
    canvas.status = 'done';
    return node;
  }

  function duplicateImageCanvasNodes(canvas, nodes) {
    if (!canvas || !nodes?.length) return [];
    pushImageCanvasHistory(canvas);
    normalizeCanvasJob(canvas);
    const clones = nodes.map((source, index) => {
      const clone = JSON.parse(JSON.stringify(source));
      clone.id = imageCanvasId('node');
      clone.title = `${source.title || imageCanvasOperationLabel(source.operation)} 副本`;
      clone.x = (Number(source.x) || 0) + 34 + index * 18;
      clone.y = (Number(source.y) || 0) + 34 + index * 18;
      clone.parentNodeId = null;
      clone.sourceNodeIds = [];
      clone.createdAt = Date.now();
      clone.error = '';
      if (clone.status === 'generating' || clone.status === 'queued') clone.status = clone.output ? 'done' : 'review';
      return clone;
    });
    canvas.nodes.push(...clones);
    canvas.selectedNodeIds = clones.map(node => node.id);
    saveImageCanvas(canvas);
    renderImageWorkspace();
    updateImageGenerateBtn();
    return clones;
  }

  function downloadImageCanvasNode(canvas, node) {
    if (!canvas || !node?.output || !isRenderableImageOutput(node.output)) {
      showToast('这个节点还没有可下载的图片');
      return;
    }
    const a = document.createElement('a');
    a.href = canvasNodeImageSource(node, canvas.params);
    a.download = `${(node.title || canvas.title || 'canvas-node').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || 'canvas-node'}.${node.output.format || node.params?.outputFormat || canvas.params?.outputFormat || 'png'}`;
    if (node.output.url && !node.output.b64) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    a.click();
  }

  function addImageCanvasVariantNodes(canvas, sources) {
    if (!canvas || !sources?.length) return;
    sources.forEach((source, index) => {
      const node = addImageCanvasReviewNode(canvas, {
        prompt: `基于「${source.title || source.prompt || '当前节点'}」生成一个新的变体：保持主体识别度，改变构图、光影、色彩或细节方向。`,
        params: saveImageParams(),
        operation: 'variant',
        sources: [source],
        title: `变体 · ${(source.title || '节点').slice(0, 16)}${index ? ` ${index + 1}` : ''}`,
      });
      if (node) node.y = (Number(source.y) || 0) + index * 42;
    });
    saveImageCanvas(canvas);
    renderImageWorkspace();
    updateImageGenerateBtn();
  }

  function nextCanvasReferencePosition(canvas) {
    normalizeCanvasJob(canvas);
    const index = canvas?.nodes?.length || 0;
    if (!index) return { x: 0, y: 0 };
    const minX = Math.min(...canvas.nodes.map(node => Number(node.x) || 0));
    const minY = Math.min(...canvas.nodes.map(node => Number(node.y) || 0));
    return {
      x: minX + (index % 3) * 260,
      y: minY + Math.floor(index / 3) * 320,
    };
  }

  function createImageCanvasReferenceNode(canvas, ref, opts = {}) {
    if (!canvas || !ref?.base64) return null;
    const params = sanitizeCurrentImageParams(Object.assign({}, opts.params || saveImageParams(), { count: 1 }));
    const format = normalizeImageFormat(ref.type || ref.base64.match(/^data:image\/([^;]+)/i)?.[1] || params.outputFormat || 'png') || 'png';
    const b64 = String(ref.base64).split(',')[1] || '';
    if (!b64) return null;
    const position = opts.position || nextCanvasReferencePosition(canvas);
    return {
      id: imageCanvasId('node'),
      title: ref.name || `参考图 ${opts.referenceIndex != null ? opts.referenceIndex + 1 : ''}`.trim() || '参考图',
      prompt: `参考图：${ref.name || '未命名图片'}`,
      x: position.x,
      y: position.y,
      params: Object.assign({}, params),
      operation: 'reference',
      parentNodeId: null,
      sourceNodeIds: [],
      inputImages: [],
      referenceIndex: opts.referenceIndex ?? null,
      model: state.imageModel,
      mapModel: state.imageMapModel,
      status: 'done',
      createdAt: Date.now(),
      output: {
        b64,
        url: '',
        revisedPrompt: '',
        format,
        bytes: imageByteSize({ b64 }),
        createdAt: Date.now(),
      },
      error: '',
    };
  }

  function addImageCanvasReferenceNode(ref) {
    if (!ref?.base64) return null;
    const params = sanitizeCurrentImageParams(Object.assign({}, saveImageParams(), { count: 1 }));
    let canvas = currentImageCanvas();
    if (!canvas) {
      canvas = createImageCanvasJob('参考图画布', params);
      state.imageJobs.unshift(canvas);
      state.currentImageJobId = canvas.id;
    }
    normalizeCanvasJob(canvas);
    const node = createImageCanvasReferenceNode(canvas, ref, { params });
    if (!node) return null;
    canvas.nodes.push(node);
    state.imageCanvasSelectedEdgeId = null;
    canvas.selectedNodeIds = [node.id];
    canvas.status = 'done';
    canvas.planStatus = canvas.nodes.some(item => item.status === 'review') ? 'review' : 'done';
    saveImageCanvas(canvas);
    renderImageWorkspace();
    updateImageGenerateBtn();
    return node;
  }

  async function requestImageCanvasOutput(prompt, params, sourceNodes, signal, inputRefs = []) {
    const refs = await imageCanvasRequestRefs(sourceNodes, inputRefs, signal);
    if ((sourceNodes || []).some(node => node?.output?.urlCachedDirty)) {
      (sourceNodes || []).forEach(node => { if (node?.output) delete node.output.urlCachedDirty; });
      saveImageCanvas(currentImageCanvas(), { sidebar: false });
    }
    if (state.imageMapModel) {
      return ImageApi.requestMappedImage(imageMapEndpoint(), prompt, params, refs, signal);
    }
    return refs.length
      ? ImageApi.requestImageEdit(effectiveImageEndpoint(), state.imageModel, prompt, params, refs, signal)
      : ImageApi.requestOneImage(effectiveImageEndpoint(), state.imageModel, prompt, params, signal);
  }

  async function requestAndApplyCanvasNode(canvas, node, params, signal) {
    node.status = 'generating';
    node.error = '';
    node.output = null;
    node.params = Object.assign({}, params);
    node.model = state.imageModel;
    node.mapModel = state.imageMapModel;
    const result = await requestImageCanvasOutput(node.prompt || canvas.prompt || '', params, imageCanvasNodeSources(canvas, node), signal, imageCanvasNodeInputRefs(node));
    const output = ImageCore.imageResultOutputs(result).find(isRenderableImageOutput);
    if (!output) throw new Error('接口未返回可显示的图片数据');
    node.output = output;
    node.status = 'done';
    node.usage = ImageCore.imageResultUsage(result);
    node.error = '';
    (canvas.edges || []).forEach(edge => {
      if (edge.from === node.id && edge.type === 'dependency') edge.type = 'reference';
    });
    return node;
  }

  function defaultCanvasPrompt(operation, sources) {
    if (operation === 'merge') return '融合所选节点：保留最好的主体、背景、构图、色彩和细节，生成一张统一完整的新图。';
    if (operation === 'optimize') return '基于当前节点继续优化：保留主体和构图，提升细节、质感、光影和整体完成度。';
    if (sources?.length) return '基于当前节点生成一个新的创作分支，保持主题一致但给出明显的新变化。';
    return '';
  }

  function imageCanvasPlannerEndpoint() {
    const promptEndpoint = imagePromptEndpoint();
    if (promptEndpoint?.baseUrl && promptEndpoint.apiKey && promptEndpoint.model && state.imagePromptModel) return promptEndpoint;
    const chatModel = conversationModel();
    const endpoint = chatEndpointForConversation();
    if (endpoint?.baseUrl && endpoint.apiKey && chatModel) {
      return { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, model: chatModel, source: 'chat', endpointId: endpoint.id };
    }
    return null;
  }

  function extractJsonObject(text) {
    const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try { return JSON.parse(raw); } catch { /* fall through */ }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fall through */ }
    }
    return null;
  }

  function localImageCanvasPlan(theme) {
    const base = theme.trim();
    return {
      title: base.slice(0, 30) || '无限画布',
      tasks: [
        { title: '整体基准', operation: 'root', prompt: `${base}。完整主体，清晰构图，统一风格，高质量成图。`, referenceIndexes: [] },
        { title: '构图分支', operation: 'branch', prompt: `${base}。探索一个更有张力的构图版本，主体关系明确，画面层次丰富。`, referenceIndexes: [] },
        { title: '氛围分支', operation: 'branch', prompt: `${base}。强化色彩、光影和情绪氛围，保持主题一致。`, referenceIndexes: [] },
        { title: '细节分支', operation: 'branch', prompt: `${base}。强化材质、细节、边缘质量和视觉完成度。`, referenceIndexes: [] },
      ],
    };
  }

  function normalizePlannerReferenceIndexes(value, refCount) {
    if (!refCount) return [];
    const raw = Array.isArray(value) ? value : [];
    return [...new Set(raw
      .map(item => Number.parseInt(item, 10))
      .filter(index => Number.isInteger(index) && index >= 0 && index < refCount))];
  }

  function normalizeImageCanvasPlan(plan, theme, refCount = 0) {
    const fallback = localImageCanvasPlan(theme);
    const rawTasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    const tasks = rawTasks.map((task, index) => ({
      title: String(task?.title || fallback.tasks[index]?.title || `任务 ${index + 1}`).trim().slice(0, 24),
      operation: ['root', 'branch', 'optimize', 'variant'].includes(task?.operation) ? task.operation : (index ? 'branch' : 'root'),
      prompt: String(task?.prompt || '').trim(),
      referenceIndexes: normalizePlannerReferenceIndexes(task?.referenceIndexes, refCount),
    })).filter(task => task.prompt).slice(0, 6);
    const finalTasks = tasks.length ? tasks : fallback.tasks.map(task => Object.assign({}, task));
    if (refCount && finalTasks.length && !finalTasks.some(task => task.referenceIndexes?.length)) {
      const allIndexes = Array.from({ length: refCount }, (_, index) => index);
      finalTasks.forEach(task => { task.referenceIndexes = [...allIndexes]; });
    }
    return {
      title: String(plan?.title || fallback.title || '无限画布').trim().slice(0, 40),
      tasks: finalTasks,
    };
  }

  function imageCanvasPlannerUserContent(theme, refs = []) {
    const cleanRefs = imageReferencePayload(refs || [], 10);
    const text = [
      `主题：${theme}`,
      cleanRefs.length ? `参考图：${cleanRefs.map((ref, index) => `${index}:${ref.name || `参考图${index + 1}`}`).join('，')}` : '',
    ].filter(Boolean).join('\n');
    if (!cleanRefs.length) return text;
    return [
      { type: 'text', text },
      ...cleanRefs.map(ref => ({
        type: 'image_url',
        image_url: { url: ref.base64 },
      })),
    ];
  }

  async function requestImageCanvasPlan(theme, signal, fallbackTheme = theme, plannerRefs = []) {
    const refs = imageReferencePayload(Array.isArray(plannerRefs) ? plannerRefs : [], 10);
    const refCount = refs.length || (Number.isFinite(plannerRefs) ? Number(plannerRefs) : 0);
    const endpoint = imageCanvasPlannerEndpoint();
    if (!endpoint) return normalizeImageCanvasPlan(localImageCanvasPlan(fallbackTheme), fallbackTheme, refCount);
    const url = requestUrl(endpoint.baseUrl, '/chat/completions');
    const referenceInstruction = refCount
      ? `用户上传了 ${refCount} 张参考图，索引从 0 到 ${refCount - 1}。你必须为每个任务输出 referenceIndexes 数组，表示该任务应连接哪些参考图。请按主题和任务目标智能分配参考图；如果某个任务需要整体保持参考一致，可包含多个索引。`
      : '用户没有上传参考图，referenceIndexes 输出空数组。';
    const resp = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0.35,
        messages: [
          {
            role: 'system',
            content: `你是图像创作工作流规划器。按用户指定模板和复杂度，把用户主题拆成可直接交给图像生成模型的任务。${referenceInstruction}只输出 JSON，不要 Markdown。JSON 格式：{"title":"画布标题","tasks":[{"title":"任务名","operation":"root|branch|optimize|variant","prompt":"完整中文生图提示词","referenceIndexes":[0]}]}。每个 prompt 必须可独立生成图片，并保持同一主题但探索不同方向。`,
          },
          { role: 'user', content: imageCanvasPlannerUserContent(theme, refs) },
        ],
      }),
      signal,
    });
    if (!resp.ok) return normalizeImageCanvasPlan(localImageCanvasPlan(fallbackTheme), fallbackTheme, refCount);
    const text = ImageCore.extractChatText(await resp.json());
    return normalizeImageCanvasPlan(extractJsonObject(text), fallbackTheme, refCount);
  }

  function imageCanvasPlannerInstruction(template, complexity, refCount = 0) {
    const templateText = {
      free: '自由拆解：不套固定结构，按主题规划互相有差异的草稿节点。',
      story: '故事分镜：按镜头、场景、情绪推进拆解，节点之间需要有连续感。',
      product: '产品视觉：按主视觉、使用场景、材质细节、卖点氛围和商业海报方向拆解。',
      character: '角色设定：按角色外观、表情动作、服饰道具、场景氛围和细节特写拆解。',
    }[template] || '自由拆解：不套固定结构，按主题规划互相有差异的草稿节点。';
    const countText = complexity === 'simple'
      ? '拆成 3 到 4 个节点。'
      : complexity === 'advanced'
        ? '拆成 6 到 8 个节点。'
        : '拆成 4 到 6 个节点。';
    const refText = refCount ? `用户附带了 ${refCount} 张参考图，规划时需要保留参考图中的主体、风格或关键视觉特征。` : '';
    return `${templateText}${countText}${refText}`;
  }

  function imageCanvasPlannerTheme(topic, template, complexity, refCount = 0) {
    return `${topic.trim()}\n\n规划要求：${imageCanvasPlannerInstruction(template, complexity, refCount)}`;
  }

  function openImageCanvasPlanner(canvas = currentImageCanvas()) {
    state.imageCanvasPlannerOpen = true;
    state.imageCanvasPlannerTopic = state.imageCanvasPlannerTopic || meaningfulImageCanvasTopic(canvas);
    state.imageCanvasPlannerTemplate = state.imageCanvasPlannerTemplate || 'free';
    state.imageCanvasPlannerComplexity = state.imageCanvasPlannerComplexity || 'standard';
    renderImageWorkspace();
    requestAnimationFrame(() => {
      dom.imageCanvasWorkspace?.querySelector('.image-canvas-planner-topic')?.focus();
    });
  }

  function closeImageCanvasPlanner(clearDraft = false) {
    state.imageCanvasPlannerOpen = false;
    if (clearDraft) {
      state.imageCanvasPlannerTopic = '';
      state.imageCanvasPlannerRefs = [];
      state.imageCanvasPlannerTemplate = 'free';
      state.imageCanvasPlannerComplexity = 'standard';
    }
    renderImageWorkspace();
  }

  async function addImageCanvasPlannerRefFiles(files) {
    const current = imageReferencePayload(state.imageCanvasPlannerRefs || [], 10);
    const slots = Math.max(0, 10 - current.length);
    const picked = Array.from(files || []).filter(file => file?.type?.startsWith('image/')).slice(0, slots);
    if (!picked.length) {
      showToast(current.length >= 10 ? '最多参考 10 张图片' : '请选择图片文件');
      return;
    }
    try {
      const refs = await Promise.all(picked.map(async (file, index) => ({
        name: file.name || pastedImageName(file, index),
        type: file.type || 'image/png',
        base64: await ImageCore.blobToDataUrl(file),
      })));
      state.imageCanvasPlannerRefs = [...current, ...refs].slice(0, 10);
      renderImageWorkspace();
    } catch (error) {
      showToast(String(error?.message || error || '参考图读取失败'));
    }
  }

  function syncImageCanvasPlannerDraft() {
    const root = dom.imageCanvasWorkspace?.querySelector('.image-canvas-planner-modal');
    if (!root) return;
    state.imageCanvasPlannerTopic = root.querySelector('.image-canvas-planner-topic')?.value.trim() || '';
    state.imageCanvasPlannerTemplate = root.querySelector('.image-canvas-planner-template')?.value || 'free';
    state.imageCanvasPlannerComplexity = root.querySelector('.image-canvas-planner-complexity')?.value || 'standard';
  }

  async function optimizeImageCanvasPlannerTopic() {
    const textarea = dom.imageCanvasWorkspace?.querySelector('.image-canvas-planner-topic');
    const prompt = textarea?.value.trim() || '';
    if (!prompt) {
      textarea?.focus();
      showToast('请输入主题后再优化');
      return;
    }
    if (!imagePromptOptimizerConfigured()) {
      showSettings('image');
      showToast('请先配置提示词优化模型');
      return;
    }
    const endpoint = imagePromptEndpoint();
    try {
      showToast('正在优化主题...');
      const optimized = await ImageApi.optimizePrompt({ baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, model: endpoint.model }, prompt);
      if (!optimized) throw new Error('接口未返回优化后的主题');
      textarea.value = optimized;
      state.imageCanvasPlannerTopic = optimized;
      showToast('主题已优化');
    } catch (error) {
      showToast(String(error?.message || error || '优化失败'));
    }
  }

  function submitImageCanvasPlanner(canvas = currentImageCanvas()) {
    syncImageCanvasPlannerDraft();
    const topic = state.imageCanvasPlannerTopic.trim();
    const textarea = dom.imageCanvasWorkspace?.querySelector('.image-canvas-planner-topic');
    if (!topic) {
      textarea?.focus();
      showToast('请输入主题后再生成草稿节点');
      return;
    }
    const template = state.imageCanvasPlannerTemplate || 'free';
    const complexity = state.imageCanvasPlannerComplexity || 'standard';
    const refs = imageReferencePayload(state.imageCanvasPlannerRefs || [], 10);
    const sources = selectedCanvasNodes(canvas).filter(item => item.output && isRenderableImageOutput(item.output));
    state.imageCanvasPlannerOpen = false;
    state.imageCanvasPlannerRefs = [];
    dom.imagePrompt.value = topic;
    generateImageCanvasPlan(imageCanvasPlannerTheme(topic, template, complexity, refs.length), saveImageParams(), {
      sources,
      inputImages: refs,
      displayTheme: topic,
    });
  }

  async function generateImageCanvasPlan(theme, params, opts = {}) {
    if (state.isGeneratingImage) return;
    params = sanitizeCurrentImageParams(Object.assign({}, params || {}, { count: 1 }));
    const sourceNodes = (opts.sources || []).filter(node => node?.output && isRenderableImageOutput(node.output));
    const controller = new AbortController();
    let canvas = currentImageCanvas();
    if (!canvas) {
      canvas = createImageCanvasJob(theme, params);
      state.imageJobs.unshift(canvas);
    }
    normalizeCanvasJob(canvas);
    const displayTheme = String(opts.displayTheme || theme || '').trim();
    const inputImages = imageReferencePayload(opts.inputImages !== undefined ? opts.inputImages : state.imageRefs);
    canvas.prompt = displayTheme || theme;
    canvas.title = (displayTheme || theme).trim().slice(0, 30) + ((displayTheme || theme).trim().length > 30 ? '...' : '');
    canvas.inputImages = inputImages;
    canvas.status = 'generating';
    canvas.planStatus = 'planning';
    state.currentImageJobId = canvas.id;
    state.isGeneratingImage = true;
    state.imageAbortController = controller;
    requestImageWakeLock();
    updateImageGenerateBtn();
    saveImageCanvas(canvas);
    renderImageWorkspace();
    updateSidebar();

    try {
      const plan = normalizeImageCanvasPlan(
        await requestImageCanvasPlan(theme, controller.signal, displayTheme || theme, inputImages),
        displayTheme || theme,
        inputImages.length
      );
      canvas.title = plan.title;
      canvas.plan = plan;
      const preservedNodes = (canvas.nodes || []).filter(node => node.output && isRenderableImageOutput(node.output));
      const sourceIds = new Set(sourceNodes.map(node => node.id));
      const anchorNodes = sourceNodes.length ? preservedNodes.filter(node => sourceIds.has(node.id)) : [];
      canvas.nodes = preservedNodes;
      canvas.edges = (canvas.edges || []).filter(edge =>
        preservedNodes.some(node => node.id === edge.from) && preservedNodes.some(node => node.id === edge.to)
      );
      const referenceNodes = inputImages.map((ref, index) => createImageCanvasReferenceNode(canvas, ref, {
        params,
        referenceIndex: index,
        position: {
          x: -320,
          y: index * 330,
        },
      })).filter(Boolean);
      canvas.nodes.push(...referenceNodes);
      const baseX = anchorNodes.length
        ? Math.max(...anchorNodes.map(node => Number(node.x) || 0)) + 320
        : referenceNodes.length ? 0 : 0;
      const baseY = anchorNodes.length
        ? Math.round(anchorNodes.reduce((sum, node) => sum + (Number(node.y) || 0), 0) / anchorNodes.length)
        : 0;
      const taskNodes = plan.tasks.map((task, index) => {
        const taskRefIndexes = normalizePlannerReferenceIndexes(task.referenceIndexes, referenceNodes.length);
        const taskReferenceNodes = taskRefIndexes.map(refIndex => referenceNodes[refIndex]).filter(Boolean);
        const sourceIdsForNode = [
          ...anchorNodes.map(source => source.id),
          ...taskReferenceNodes.map(source => source.id),
        ];
        const node = {
          id: imageCanvasId('node'),
          title: task.title,
          prompt: task.prompt,
          x: baseX + (index % 3) * 280,
          y: baseY + Math.floor(index / 3) * 330,
          params: Object.assign({}, params),
          operation: task.operation || (index ? 'branch' : 'root'),
          sourceNodeIds: sourceIdsForNode,
          inputImages: [],
          model: state.imageModel,
          mapModel: state.imageMapModel,
          status: 'review',
          createdAt: Date.now(),
          output: null,
          error: '',
        };
        canvas.nodes.push(node);
        anchorNodes.forEach(source => canvas.edges.push({ id: imageCanvasId('edge'), from: source.id, to: node.id, type: 'branch' }));
        taskReferenceNodes.forEach(source => canvas.edges.push({ id: imageCanvasId('edge'), from: source.id, to: node.id, type: 'reference' }));
        return node;
      });
      state.imageCanvasSelectedEdgeId = null;
      canvas.selectedNodeIds = canvas.nodes[0] ? [canvas.nodes[0].id] : [];
      if (taskNodes[0]) canvas.selectedNodeIds = [taskNodes[0].id];
      canvas.status = 'done';
      canvas.planStatus = 'review';
      if (canvas.inputImages?.length) { setImageReferences([]); renderImageRefPreview(); }
      showToast('任务已拆分，请确认后开始执行');
    } catch (error) {
      canvas.status = 'done';
      canvas.planStatus = 'error';
      showToast(error?.name === 'AbortError' ? '生成已中断' : String(error?.message || error || '画布规划失败'));
    } finally {
      state.isGeneratingImage = false;
      state.imageAbortController = null;
      releaseImageWakeLock();
      saveImageCanvas(canvas);
      renderImageWorkspace();
      updateSidebar();
      updateImageGenerateBtn();
    }
  }

  async function runImageCanvasPlan(canvas = currentImageCanvas()) {
    if (!canvas?.plan?.tasks?.length || state.isGeneratingImage) return;
    normalizeCanvasJob(canvas);
    const params = sanitizeCurrentImageParams(Object.assign({}, canvas.params || DEFAULT_IMAGE_PARAMS, { count: 1 }));
    const planInputImages = imageReferencePayload(canvas.inputImages || []);
    const tasks = normalizeImageCanvasPlan(canvas.plan, canvas.prompt || canvas.title || '', planInputImages.length).tasks;
    const controller = new AbortController();
    canvas.nodes = [];
    canvas.edges = [];
    canvas.selectedNodeIds = [];
    canvas.status = 'generating';
    canvas.planStatus = 'generating';
    state.isGeneratingImage = true;
    state.imageAbortController = controller;
    requestImageWakeLock();
    updateImageGenerateBtn();

    const planNode = {
      id: imageCanvasId('node'),
      title: '主题规划',
      prompt: canvas.prompt || canvas.title || '',
      x: 0,
      y: 80,
      params: Object.assign({}, params),
      operation: 'plan',
      status: 'done',
      createdAt: Date.now(),
      output: null,
      error: '',
    };
    canvas.nodes.push(planNode);
    canvas.selectedNodeIds = [planNode.id];
    saveImageCanvas(canvas);
    renderImageWorkspace();

    try {
      const referenceNodes = planInputImages.map((ref, index) => createImageCanvasReferenceNode(canvas, ref, {
        params,
        referenceIndex: index,
        position: {
          x: 0,
          y: 80 + index * 330,
        },
      })).filter(Boolean);
      if (referenceNodes.length) {
        canvas.nodes.push(...referenceNodes);
        planNode.x = -320;
        planNode.y = 80 + referenceNodes.length * 330;
      }
      const taskNodes = tasks.map((task, index) => {
        const taskRefIndexes = normalizePlannerReferenceIndexes(task.referenceIndexes, referenceNodes.length);
        const taskReferenceNodes = taskRefIndexes.map(refIndex => referenceNodes[refIndex]).filter(Boolean);
        const sourceIdsForNode = [
          planNode.id,
          ...taskReferenceNodes.map(source => source.id),
        ];
        const node = {
          id: imageCanvasId('node'),
          title: task.title,
          prompt: task.prompt,
          x: 320,
          y: index * 270,
          params: Object.assign({}, params),
          operation: task.operation || (index ? 'branch' : 'root'),
          parentNodeId: planNode.id,
          sourceNodeIds: sourceIdsForNode,
          inputImages: [],
          model: state.imageModel,
          mapModel: state.imageMapModel,
          status: 'queued',
          createdAt: Date.now(),
          output: null,
          error: '',
        };
        canvas.nodes.push(node);
        canvas.edges.push({ id: imageCanvasId('edge'), from: planNode.id, to: node.id, type: 'branch' });
        taskReferenceNodes.forEach(source => canvas.edges.push({ id: imageCanvasId('edge'), from: source.id, to: node.id, type: 'reference' }));
        return node;
      });
      state.imageCanvasSelectedEdgeId = null;
      const maxParallel = Math.min(MAX_CANVAS_PARALLEL, Math.max(1, taskNodes.length));
      let nextIndex = 0;
      let completed = 0;
      let success = 0;
      let failed = 0;
      canvas.planProgress = { total: taskNodes.length, completed, success, failed, maxParallel };
      saveImageCanvas(canvas, { sidebar: false });
      renderImageWorkspace();

      const updateProgress = () => {
        canvas.planProgress = { total: taskNodes.length, completed, success, failed, maxParallel };
        saveImageCanvas(canvas, { sidebar: false });
        renderImageWorkspace();
      };
      const worker = async () => {
        while (nextIndex < taskNodes.length && !controller.signal.aborted) {
          const node = taskNodes[nextIndex++];
          canvas.selectedNodeIds = [node.id];
          node.status = 'generating';
          updateProgress();
          try {
            await requestAndApplyCanvasNode(canvas, node, params, controller.signal);
            success += 1;
          } catch (error) {
            node.status = 'error';
            node.error = error?.name === 'AbortError' ? '请求已中断' : String(error?.message || error || '生成失败');
            failed += 1;
            if (error?.name === 'AbortError') throw error;
          } finally {
            completed += 1;
            updateProgress();
          }
        }
      };
      await Promise.all(Array.from({ length: maxParallel }, () => worker()));
      canvas.status = 'done';
      canvas.planStatus = 'done';
      canvas.planProgress = { total: taskNodes.length, completed, success, failed, maxParallel };
      const failedCount = canvas.nodes.filter(node => node.status === 'error' || node.error).length;
      showToast(failedCount ? `任务执行完成，失败 ${failedCount} 个，可点击节点重试` : '画布任务已执行');
    } catch (error) {
      canvas.status = 'done';
      canvas.planStatus = error?.name === 'AbortError' ? 'review' : 'error';
      showToast(error?.name === 'AbortError' ? '生成已中断' : String(error?.message || error || '任务执行失败'));
    } finally {
      state.isGeneratingImage = false;
      state.imageAbortController = null;
      releaseImageWakeLock();
      saveImageCanvas(canvas);
      renderImageWorkspace();
      updateSidebar();
      updateImageGenerateBtn();
    }
  }

  function imageCanvasNodeSources(canvas, node) {
    return [
      ...imageCanvasReferenceSourceNodes(canvas, node),
      ...imageCanvasGeneratedSourceNodes(canvas, node),
    ];
  }

  function imageCanvasNodeNeedsGeneration(node) {
    return !!(node && node.prompt && !node.output && node.status !== 'generating' && node.operation !== 'plan');
  }

  function imageCanvasSourceNodes(canvas, node) {
    const ids = new Set(node?.sourceNodeIds || []);
    return (canvas?.nodes || []).filter(item => ids.has(item.id));
  }

  function imageCanvasHasPath(canvas, fromId, toId, seen = new Set()) {
    if (!canvas || !fromId || !toId) return false;
    if (fromId === toId) return true;
    if (seen.has(fromId)) return false;
    seen.add(fromId);
    return (canvas.edges || [])
      .filter(edge => edge.from === fromId)
      .some(edge => imageCanvasHasPath(canvas, edge.to, toId, seen));
  }

  function collectImageCanvasRunnableWithDependencies(canvas, nodes) {
    normalizeCanvasJob(canvas);
    const requested = new Set((nodes || []).filter(Boolean).map(node => node.id));
    const runnable = new Map();
    const visit = (node) => {
      if (!node || runnable.has(node.id)) return;
      imageCanvasSourceNodes(canvas, node).forEach(source => {
        if (imageCanvasNodeNeedsGeneration(source)) visit(source);
      });
      if (requested.has(node.id) || imageCanvasNodeNeedsGeneration(node)) {
        if (imageCanvasNodeNeedsGeneration(node)) runnable.set(node.id, node);
      }
    };
    (nodes || []).forEach(visit);
    return [...runnable.values()];
  }

  function imageCanvasReadyToRun(canvas, node, runnableIds) {
    const generatedSources = imageCanvasSourceNodes(canvas, node).filter(source => runnableIds.has(source.id));
    return generatedSources.every(source => source.output && isRenderableImageOutput(source.output));
  }

  function waitImageCanvasDependencyTick() {
    return new Promise(resolve => setTimeout(resolve, 80));
  }

  function canvasEdgeExists(canvas, fromId, toId) {
    return (canvas?.edges || []).some(edge => edge.from === fromId && edge.to === toId);
  }

  function connectImageCanvasNodes(canvas, fromId, toId) {
    normalizeCanvasJob(canvas);
    if (!canvas || !fromId || !toId) return false;
    if (fromId === toId) {
      state.imageCanvasConnectFrom = null;
      showToast('不能连接到同一个节点');
      renderImageWorkspace();
      return false;
    }
    const from = canvas.nodes.find(node => node.id === fromId);
    const to = canvas.nodes.find(node => node.id === toId);
    if (!from || !to) return false;
    if (canvasEdgeExists(canvas, fromId, toId)) {
      state.imageCanvasConnectFrom = null;
      showToast('这两个节点已经有参考连线');
      renderImageWorkspace();
      return false;
    }
    if (imageCanvasHasPath(canvas, toId, fromId)) {
      state.imageCanvasConnectFrom = null;
      showToast('不能形成循环连线');
      renderImageWorkspace();
      return false;
    }
    pushImageCanvasHistory(canvas);
    const edgeId = imageCanvasId('edge');
    const edgeType = from.output && isRenderableImageOutput(from.output) ? 'reference' : 'dependency';
    canvas.edges.push({ id: edgeId, from: fromId, to: toId, type: edgeType });
    const sourceIds = new Set(to.sourceNodeIds || []);
    sourceIds.add(fromId);
    to.sourceNodeIds = [...sourceIds];
    if (!to.parentNodeId) to.parentNodeId = fromId;
    canvas.selectedNodeIds = [toId];
    state.imageCanvasConnectFrom = null;
    state.imageCanvasSelectedEdgeId = null;
    saveImageCanvas(canvas);
    renderImageWorkspace();
    updateImageGenerateBtn();
    showToast(edgeType === 'dependency' ? '依赖连线已建立' : '参考连线已建立');
    return true;
  }

  function selectImageCanvasEdge(canvas, edgeId) {
    normalizeCanvasJob(canvas);
    if (!canvas || !edgeId || !(canvas.edges || []).some(edge => edge.id === edgeId)) return;
    state.imageCanvasSelectedEdgeId = edgeId;
    state.imageCanvasConnectFrom = null;
    canvas.selectedNodeIds = [];
    saveImageCanvas(canvas, { sidebar: false });
    renderImageWorkspace();
    updateImageGenerateBtn();
  }

  function disconnectImageCanvasEdge(canvas, edgeId = state.imageCanvasSelectedEdgeId) {
    normalizeCanvasJob(canvas);
    if (!canvas || !edgeId) return;
    const edge = (canvas.edges || []).find(item => item.id === edgeId);
    if (!edge) return;
    pushImageCanvasHistory(canvas);
    canvas.edges = (canvas.edges || []).filter(item => item.id !== edgeId);
    const toNode = (canvas.nodes || []).find(node => node.id === edge.to);
    if (toNode) {
      toNode.sourceNodeIds = (toNode.sourceNodeIds || []).filter(id => id !== edge.from);
      if (toNode.parentNodeId === edge.from) toNode.parentNodeId = toNode.sourceNodeIds[0] || null;
    }
    state.imageCanvasSelectedEdgeId = null;
    state.imageCanvasConnectFrom = null;
    saveImageCanvas(canvas);
    renderImageWorkspace();
    updateImageGenerateBtn();
    showToast('参考线已断开');
  }

  async function retryImageCanvasNode(canvas, node) {
    if (!canvas || !node || state.isGeneratingImage) return;
    normalizeCanvasJob(canvas);
    const params = sanitizeCurrentImageParams(Object.assign({}, canvas.params || node.params || DEFAULT_IMAGE_PARAMS, { count: 1 }));
    const controller = new AbortController();
    state.isGeneratingImage = true;
    state.imageAbortController = controller;
    requestImageWakeLock();
    node.status = 'generating';
    node.error = '';
    node.output = null;
    node.params = Object.assign({}, params);
    node.model = state.imageModel;
    node.mapModel = state.imageMapModel;
    saveImageCanvas(canvas, { sidebar: false });
    renderImageWorkspace();
    updateImageGenerateBtn();

    try {
      const result = await requestImageCanvasOutput(node.prompt || canvas.prompt || '', params, imageCanvasNodeSources(canvas, node), controller.signal, imageCanvasNodeInputRefs(node));
      const output = ImageCore.imageResultOutputs(result).find(isRenderableImageOutput);
      if (!output) throw new Error('接口未返回可显示的图片数据');
      node.output = output;
      node.status = 'done';
      node.usage = ImageCore.imageResultUsage(result);
      showToast('节点已重试成功');
    } catch (error) {
      node.status = 'error';
      node.error = error?.name === 'AbortError' ? '请求已中断' : String(error?.message || error || '生成失败');
      showToast(node.error);
    } finally {
      state.isGeneratingImage = false;
      state.imageAbortController = null;
      releaseImageWakeLock();
      saveImageCanvas(canvas);
      renderImageWorkspace();
      updateSidebar();
      updateImageGenerateBtn();
    }
  }

  async function runImageCanvasNodes(canvas = currentImageCanvas(), nodes = []) {
    if (!canvas || state.isGeneratingImage) return;
    const runnable = collectImageCanvasRunnableWithDependencies(canvas, nodes);
    if (!runnable.length) return;
    normalizeCanvasJob(canvas);
    const params = sanitizeCurrentImageParams(Object.assign({}, canvas.params || DEFAULT_IMAGE_PARAMS, { count: 1 }));
    const controller = new AbortController();
    const maxParallel = Math.min(MAX_CANVAS_PARALLEL, runnable.length);
    const runnableIds = new Set(runnable.map(node => node.id));
    const pending = new Set(runnable.map(node => node.id));
    const running = new Set();
    let completed = 0;
    let success = 0;
    let failed = 0;
    state.isGeneratingImage = true;
    state.imageAbortController = controller;
    requestImageWakeLock();
    canvas.planStatus = 'generating';
    canvas.planProgress = { total: runnable.length, completed, success, failed, maxParallel };
    saveImageCanvas(canvas, { sidebar: false });
    renderImageWorkspace();
    updateImageGenerateBtn();

    const updateProgress = () => {
      canvas.planProgress = { total: runnable.length, completed, success, failed, maxParallel };
      saveImageCanvas(canvas, { sidebar: false });
      renderImageWorkspace();
    };
    const runNode = async (node) => {
      running.add(node.id);
      pending.delete(node.id);
      canvas.selectedNodeIds = [node.id];
      node.status = 'generating';
      node.error = '';
      updateProgress();
      try {
        await requestAndApplyCanvasNode(canvas, node, params, controller.signal);
        success += 1;
      } catch (error) {
        node.status = 'error';
        node.error = error?.name === 'AbortError' ? '请求已中断' : String(error?.message || error || '生成失败');
        failed += 1;
        if (error?.name === 'AbortError') throw error;
      } finally {
        completed += 1;
        running.delete(node.id);
        updateProgress();
      }
    };
    const worker = async () => {
      while (pending.size && !controller.signal.aborted) {
        const node = runnable.find(item => pending.has(item.id) && imageCanvasReadyToRun(canvas, item, runnableIds));
        if (!node) {
          if (running.size) {
            await waitImageCanvasDependencyTick();
            continue;
          }
          const blocked = runnable.find(item => pending.has(item.id));
          if (blocked) {
            blocked.status = 'error';
            blocked.error = '上游依赖节点未生成成功，无法继续执行';
            pending.delete(blocked.id);
            failed += 1;
            completed += 1;
            updateProgress();
            continue;
          }
          return;
        }
        await runNode(node);
      }
    };
    try {
      await Promise.all(Array.from({ length: maxParallel }, () => worker()));
      showToast(failed ? `执行完成，失败 ${failed} 个` : '节点已执行');
    } catch (error) {
      showToast(error?.name === 'AbortError' ? '执行已中断' : String(error?.message || error || '执行失败'));
    } finally {
      canvas.planStatus = 'done';
      state.isGeneratingImage = false;
      state.imageAbortController = null;
      releaseImageWakeLock();
      saveImageCanvas(canvas);
      renderImageWorkspace();
      updateSidebar();
      updateImageGenerateBtn();
    }
  }
  async function retryFailedImageCanvasNodes(canvas = currentImageCanvas()) {
    if (!canvas || state.isGeneratingImage) return;
    const failed = (canvas.nodes || []).filter(node => node.error || node.status === 'error');
    if (!failed.length) return;
    normalizeCanvasJob(canvas);
    const params = sanitizeCurrentImageParams(Object.assign({}, canvas.params || DEFAULT_IMAGE_PARAMS, { count: 1 }));
    const controller = new AbortController();
    const maxParallel = Math.min(MAX_CANVAS_PARALLEL, failed.length);
    let nextIndex = 0;
    let completed = 0;
    let success = 0;
    let failedCount = 0;
    state.isGeneratingImage = true;
    state.imageAbortController = controller;
    requestImageWakeLock();
    canvas.planStatus = 'generating';
    canvas.planProgress = { total: failed.length, completed, success, failed: failedCount, maxParallel };
    saveImageCanvas(canvas, { sidebar: false });
    renderImageWorkspace();
    updateImageGenerateBtn();

    const updateProgress = () => {
      canvas.planProgress = { total: failed.length, completed, success, failed: failedCount, maxParallel };
      saveImageCanvas(canvas, { sidebar: false });
      renderImageWorkspace();
    };
    const worker = async () => {
      while (nextIndex < failed.length && !controller.signal.aborted) {
        const node = failed[nextIndex++];
        canvas.selectedNodeIds = [node.id];
        node.status = 'generating';
        node.error = '';
        updateProgress();
        try {
          await requestAndApplyCanvasNode(canvas, node, params, controller.signal);
          success += 1;
        } catch (error) {
          node.status = 'error';
          node.error = error?.name === 'AbortError' ? '请求已中断' : String(error?.message || error || '生成失败');
          failedCount += 1;
          if (error?.name === 'AbortError') throw error;
        } finally {
          completed += 1;
          updateProgress();
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: maxParallel }, () => worker()));
      showToast(failedCount ? `重试完成，仍失败 ${failedCount} 个` : '失败节点已全部重试成功');
    } catch (error) {
      showToast(error?.name === 'AbortError' ? '重试已中断' : String(error?.message || error || '重试失败'));
    } finally {
      canvas.planStatus = 'done';
      state.isGeneratingImage = false;
      state.imageAbortController = null;
      releaseImageWakeLock();
      saveImageCanvas(canvas);
      renderImageWorkspace();
      updateSidebar();
      updateImageGenerateBtn();
    }
  }

  async function generateImageCanvasNode(prompt, params, opts = {}) {
    if (!ensureModeConfigured('image')) return;
    if (!imageMapConfigured()) {
      showSettings('image');
      showToast('请完善映射模型对应的接口配置');
      return;
    }
    if (state.isGeneratingImage) return;
    params = sanitizeCurrentImageParams(Object.assign({}, params || {}, { count: 1 }));
    const operation = opts.operation || 'branch';
    const existingCanvas = currentImageCanvas();
    const selected = selectedCanvasNodes(existingCanvas).filter(node => node.output && isRenderableImageOutput(node.output));
    const sources = opts.sources !== undefined ? opts.sources : (operation === 'root' ? [] : selected);
    const inputImages = imageReferencePayload(opts.inputImages !== undefined ? opts.inputImages : state.imageRefs);
    const finalPrompt = (prompt || defaultCanvasPrompt(operation, sources)).trim();
    if (!finalPrompt) return;
    if (operation === 'root') {
      await generateImageCanvasPlan(finalPrompt, params, { sources });
      return;
    }
    if (operation === 'merge' && sources.length < 2) {
      showToast('请至少选择两个已生成节点再合并');
      return;
    }
    if (operation !== 'root' && !sources.length && existingCanvas?.nodes?.length) {
      showToast('请先选择一个已生成节点');
      return;
    }

    let canvas = existingCanvas;
    if (!canvas) {
      canvas = createImageCanvasJob(finalPrompt, params);
      state.imageJobs.unshift(canvas);
      state.currentImageJobId = canvas.id;
    }
    normalizeCanvasJob(canvas);
    if (!canvas.nodes.length) canvas.prompt = finalPrompt;
    canvas.params = Object.assign({}, params);
    canvas.model = state.imageModel;
    canvas.mapModel = state.imageMapModel;
    canvas.status = 'generating';
    const node = addImageCanvasNode(canvas, {
      prompt: finalPrompt,
      params,
      operation: canvas.nodes.length ? operation : 'root',
      sources,
      inputImages,
    });

    state.isGeneratingImage = true;
    const controller = new AbortController();
    state.imageAbortController = controller;
    requestImageWakeLock();
    updateImageGenerateBtn();
    saveImageCanvas(canvas);
    renderImageWorkspace();
    updateSidebar();

    try {
      const result = await requestImageCanvasOutput(finalPrompt, params, sources, controller.signal, inputImages);
      const output = ImageCore.imageResultOutputs(result).find(isRenderableImageOutput);
      if (!output) throw new Error('接口未返回可显示的图片数据');
      node.output = output;
      node.status = 'done';
      node.error = '';
      node.usage = ImageCore.imageResultUsage(result);
      canvas.status = 'done';
      canvas.updatedAt = Date.now();
      if (!canvas.title || canvas.title === '无限画布') canvas.title = finalPrompt.slice(0, 30);
      if (inputImages.length) { setImageReferences([]); renderImageRefPreview(); }
      showToast(operation === 'merge' ? '节点已合并' : '画布节点已生成');
    } catch (error) {
      node.status = 'error';
      node.error = error?.name === 'AbortError' ? '请求已中断' : String(error?.message || error || '生成失败');
      canvas.status = canvas.nodes.some(item => item.status === 'generating') ? 'generating' : 'done';
      showToast(node.error);
    } finally {
      state.isGeneratingImage = false;
      state.imageAbortController = null;
      releaseImageWakeLock();
      saveImageCanvas(canvas);
      renderImageWorkspace();
      updateSidebar();
      updateImageGenerateBtn();
    }
  }

  function openImageCanvasNodeViewer(canvas, node) {
    if (!node?.output || !isRenderableImageOutput(node.output)) {
      showToast('这个节点还没有可查看的图片');
      return;
    }
    const items = (canvas.nodes || [])
      .filter(item => item.output && isRenderableImageOutput(item.output))
      .map(item => ({
        jobId: canvas.id,
        nodeId: item.id,
        index: 0,
        src: canvasNodeImageSource(item, canvas.params),
        out: item.output,
      }));
    const index = Math.max(0, items.findIndex(item => item.nodeId === node.id));
    ImageViewer.openItems(items, index);
  }

  function selectImageCanvasNode(canvas, nodeId, additive = false) {
    if (!canvas || !nodeId) return;
    normalizeCanvasJob(canvas);
    state.imageCanvasSelectedEdgeId = null;
    if (additive) {
      const set = new Set(canvas.selectedNodeIds || []);
      if (set.has(nodeId)) set.delete(nodeId);
      else set.add(nodeId);
      canvas.selectedNodeIds = [...set];
    } else {
      canvas.selectedNodeIds = [nodeId];
    }
    saveImageCanvas(canvas, { sidebar: false });
    renderImageWorkspace();
    updateImageGenerateBtn();
  }

  function setImageCanvasNodeSelection(canvas, nodeId, additive = false) {
    if (!canvas || !nodeId) return;
    normalizeCanvasJob(canvas);
    state.imageCanvasSelectedEdgeId = null;
    if (additive) {
      const set = new Set(canvas.selectedNodeIds || []);
      if (set.has(nodeId)) set.delete(nodeId);
      else set.add(nodeId);
      canvas.selectedNodeIds = [...set];
    } else {
      canvas.selectedNodeIds = [nodeId];
    }
    saveImageCanvas(canvas, { sidebar: false });
    updateImageGenerateBtn();
  }

  function imageCanvasNodeRect(node) {
    return {
      x: Number(node?.x) || 0,
      y: Number(node?.y) || 0,
      w: 236,
      h: 360,
    };
  }

  function handleImageCanvasAction(action, target) {
    const canvas = currentImageCanvas();
    const nodeId = target?.dataset?.node || '';
    const node = canvas?.nodes?.find(item => item.id === nodeId);
    if (node && !['canvas-view-node', 'canvas-focus-node'].includes(action)) {
      canvas.selectedNodeIds = [node.id];
      saveImageCanvas(canvas, { sidebar: false });
    }
    const selectedNodes = selectedCanvasNodes(canvas);
    const selected = selectedNodes.filter(item => item.output && isRenderableImageOutput(item.output));
    if (action === 'canvas-exit') {
      if (isImageCanvasJob(currentImageJob())) {
        state.currentImageJobId = state.imageJobs.find(job => !isImageCanvasJob(job))?.id || null;
      }
      state.imageCanvasMode = false;
      persist([KEYS.currentImageJobId, KEYS.imageCanvasMode]);
      document.body.classList.remove('image-canvas-open');
      updateSidebar();
      renderImageWorkspace();
      updateImageGenerateBtn();
      dom.imagePrompt?.focus();
      return;
    }
    if (action === 'canvas-stop') {
      state.imageAbortController?.abort();
      return;
    }
    if (action === 'canvas-undo') {
      undoImageCanvas(canvas);
      return;
    }
    if (action === 'canvas-redo') {
      redoImageCanvas(canvas);
      return;
    }
    if (action === 'canvas-export') {
      exportImageCanvas(canvas);
      return;
    }
    if (action === 'canvas-import') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.addEventListener('change', () => importImageCanvasFile(input.files?.[0]));
      input.click();
      return;
    }
    if (action === 'canvas-new') {
      const canvas = createImageCanvasJob('无限画布', sanitizeCurrentImageParams(saveImageParams()));
      state.imageJobs.unshift(canvas);
      state.currentImageJobId = canvas.id;
      state.imageCanvasMode = true;
      dom.imagePrompt.value = '';
      state.imageCanvasPlannerOpen = false;
      imageDbPutJob(persistedImageCanvas(canvas));
      persist([KEYS.currentImageJobId, KEYS.imageCanvasMode]);
      updateSidebar();
      renderImageWorkspace();
      updateImageGenerateBtn();
      return;
    }
    if (action === 'canvas-plan-topic') {
      openImageCanvasPlanner(canvas);
      return;
    }
    if (action === 'canvas-close-planner') {
      closeImageCanvasPlanner();
      return;
    }
    if (action === 'canvas-submit-planner') {
      submitImageCanvasPlanner(canvas);
      return;
    }
    if (action === 'canvas-optimize-planner-topic') {
      optimizeImageCanvasPlannerTopic();
      return;
    }
    if (action === 'canvas-pick-planner-refs') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp';
      input.multiple = true;
      input.addEventListener('change', () => addImageCanvasPlannerRefFiles(input.files));
      input.click();
      return;
    }
    if (action === 'canvas-remove-planner-ref') {
      syncImageCanvasPlannerDraft();
      const index = parseInt(target?.dataset?.ref || '-1', 10);
      const refs = imageReferencePayload(state.imageCanvasPlannerRefs || [], 10);
      if (index >= 0) refs.splice(index, 1);
      state.imageCanvasPlannerRefs = refs;
      renderImageWorkspace();
      return;
    }
    if (action === 'canvas-add-ref') {
      dom.imageRefInput?.click();
      return;
    }
    if (action === 'canvas-remove-ref') {
      const index = parseInt(target?.dataset?.ref || '-1', 10);
      const refs = imageReferenceList();
      if (index >= 0) refs.splice(index, 1);
      setImageReferences(refs);
      renderImageRefPreview();
      renderImageWorkspace();
      updateImageGenerateBtn();
      return;
    }
    if (action === 'canvas-focus-task') {
      const index = parseInt(target?.dataset?.task || '-1', 10);
      if (!canvas || !Number.isFinite(index) || index < 0) return;
      if (canvas.planStatus === 'review') {
        const taskEl = dom.imageCanvasWorkspace?.querySelector(`.image-canvas-task[data-task="${index}"]`);
        taskEl?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        taskEl?.querySelector('textarea, input')?.focus();
        return;
      }
      const generatedNodes = (canvas.nodes || []).filter(node => node.operation !== 'plan');
      const node = generatedNodes[index];
      if (node) selectImageCanvasNode(canvas, node.id);
      return;
    }
    if (action === 'canvas-focus-node') {
      if (!canvas || !node) return;
      selectImageCanvasNode(canvas, node.id);
      focusImageCanvasNode(node);
      return;
    }
    if (action === 'canvas-focus-selected') {
      if (!canvas || !selectedNodes[0]) return;
      focusImageCanvasNode(selectedNodes[0]);
      return;
    }
    if (action === 'canvas-clear-selection') {
      if (!canvas) return;
      canvas.selectedNodeIds = [];
      state.imageCanvasSelectedEdgeId = null;
      saveImageCanvas(canvas, { sidebar: false });
      renderImageWorkspace();
      updateImageGenerateBtn();
      return;
    }
    if (action === 'canvas-fit') {
      fitImageCanvas();
      return;
    }
    if (action === 'canvas-auto-layout') {
      autoLayoutImageCanvas(canvas);
      return;
    }
    if (action === 'canvas-zoom-in' || action === 'canvas-zoom-out') {
      const vp = canvasViewport(canvas);
      const factor = action === 'canvas-zoom-in' ? 1.15 : .85;
      setCanvasViewport({ x: vp.x, y: vp.y, zoom: vp.zoom * factor });
      return;
    }
    if (action === 'canvas-view-node') {
      if (canvas && node) openImageCanvasNodeViewer(canvas, node);
      return;
    }
    if (action === 'canvas-download-node') {
      if (canvas && node) downloadImageCanvasNode(canvas, node);
      return;
    }
    if (action === 'canvas-download-selected') {
      selected.forEach(item => downloadImageCanvasNode(canvas, item));
      return;
    }
    if (action === 'canvas-copy-prompt') {
      const prompt = (node || selectedNodes[0])?.prompt || '';
      if (prompt) copyText(prompt);
      return;
    }
    if (action === 'canvas-select-edge') {
      if (canvas) selectImageCanvasEdge(canvas, target?.dataset?.edge || '');
      return;
    }
    if (action === 'canvas-disconnect-edge') {
      if (canvas) disconnectImageCanvasEdge(canvas);
      return;
    }
    if (action === 'canvas-connect-node') {
      if (!canvas || !node) return;
      if (state.imageCanvasConnectFrom && state.imageCanvasConnectFrom !== node.id) {
        connectImageCanvasNodes(canvas, state.imageCanvasConnectFrom, node.id);
        return;
      }
      state.imageCanvasConnectFrom = state.imageCanvasConnectFrom === node.id ? null : node.id;
      state.imageCanvasSelectedEdgeId = null;
      canvas.selectedNodeIds = [node.id];
      saveImageCanvas(canvas, { sidebar: false });
      renderImageWorkspace();
      showToast(state.imageCanvasConnectFrom ? '已选择连线起点，请点击目标节点' : '已取消连线');
      return;
    }
    if (action === 'canvas-duplicate-node') {
      if (canvas && node) duplicateImageCanvasNodes(canvas, [node]);
      return;
    }
    if (action === 'canvas-duplicate-selected') {
      duplicateImageCanvasNodes(canvas, selectedNodes);
      return;
    }
    if (action === 'canvas-variant-selected') {
      addImageCanvasVariantNodes(canvas, selected);
      return;
    }
    if (action === 'canvas-run-node') {
      if (canvas && node) runImageCanvasNodes(canvas, [node]);
      return;
    }
    if (action === 'canvas-run-review') {
      if (canvas) runImageCanvasNodes(canvas, (canvas.nodes || []).filter(item => item.status === 'review'));
      return;
    }
    if (action === 'canvas-delete-node') {
      if (!canvas || !node) return;
      pushImageCanvasHistory(canvas);
      const removeId = node.id;
      const removedEdgeIds = new Set((canvas.edges || [])
        .filter(edge => edge.from === removeId || edge.to === removeId)
        .map(edge => edge.id));
      canvas.nodes = (canvas.nodes || []).filter(item => item.id !== removeId);
      canvas.edges = (canvas.edges || []).filter(edge => edge.from !== removeId && edge.to !== removeId);
      canvas.nodes.forEach(item => {
        item.sourceNodeIds = (item.sourceNodeIds || []).filter(id => id !== removeId);
        if (item.parentNodeId === removeId) item.parentNodeId = item.sourceNodeIds[0] || null;
      });
      canvas.selectedNodeIds = (canvas.selectedNodeIds || []).filter(id => id !== removeId);
      if (state.imageCanvasConnectFrom === removeId) state.imageCanvasConnectFrom = null;
      if (removedEdgeIds.has(state.imageCanvasSelectedEdgeId)) state.imageCanvasSelectedEdgeId = null;
      saveImageCanvas(canvas);
      renderImageWorkspace();
      return;
    }
    if (action === 'canvas-delete-selected') {
      if (!canvas || !selectedNodes.length) return;
      pushImageCanvasHistory(canvas);
      const removeIds = new Set(selectedNodes.map(item => item.id));
      const removedEdgeIds = new Set((canvas.edges || [])
        .filter(edge => removeIds.has(edge.from) || removeIds.has(edge.to))
        .map(edge => edge.id));
      canvas.nodes = (canvas.nodes || []).filter(item => !removeIds.has(item.id));
      canvas.edges = (canvas.edges || []).filter(edge => !removeIds.has(edge.from) && !removeIds.has(edge.to));
      canvas.nodes.forEach(item => {
        item.sourceNodeIds = (item.sourceNodeIds || []).filter(id => !removeIds.has(id));
        if (removeIds.has(item.parentNodeId)) item.parentNodeId = item.sourceNodeIds[0] || null;
      });
      canvas.selectedNodeIds = [];
      if (removeIds.has(state.imageCanvasConnectFrom)) state.imageCanvasConnectFrom = null;
      if (removedEdgeIds.has(state.imageCanvasSelectedEdgeId)) state.imageCanvasSelectedEdgeId = null;
      if (canvas.planStatus === 'review' && !(canvas.nodes || []).some(item => item.status === 'review')) canvas.planStatus = 'done';
      saveImageCanvas(canvas);
      renderImageWorkspace();
      updateImageGenerateBtn();
      return;
    }
    if (action === 'canvas-add-task') {
      if (!canvas?.plan) return;
      pushImageCanvasHistory(canvas);
      canvas.plan.tasks = Array.isArray(canvas.plan.tasks) ? canvas.plan.tasks : [];
      canvas.plan.tasks.push({
        title: `任务 ${canvas.plan.tasks.length + 1}`,
        operation: canvas.plan.tasks.length ? 'branch' : 'root',
        prompt: `${canvas.prompt || canvas.title || ''}。补充一个新的创作方向。`.trim(),
      });
      saveImageCanvas(canvas, { sidebar: false });
      renderImageWorkspace();
      return;
    }
    if (action === 'canvas-remove-task') {
      const index = parseInt(target?.dataset?.task || '-1', 10);
      if (!canvas?.plan || !Number.isFinite(index)) return;
      pushImageCanvasHistory(canvas);
      canvas.plan.tasks = (canvas.plan.tasks || []).filter((_, taskIndex) => taskIndex !== index);
      saveImageCanvas(canvas, { sidebar: false });
      renderImageWorkspace();
      return;
    }
    if (action === 'canvas-run-plan') {
      runImageCanvasPlan(canvas);
      return;
    }
    if (action === 'canvas-retry-node') {
      if (canvas && node) retryImageCanvasNode(canvas, node);
      return;
    }
    if (action === 'canvas-retry-selected') {
      const retryNode = selectedNodes.find(item => item.error || item.status === 'error') || selectedNodes[0];
      if (canvas && retryNode) retryImageCanvasNode(canvas, retryNode);
      return;
    }
    if (action === 'canvas-retry-failed') {
      retryFailedImageCanvasNodes(canvas);
      return;
    }
    if (action === 'canvas-branch-node' || action === 'canvas-branch') {
      if (!canvas) return;
      const sources = node?.output && isRenderableImageOutput(node.output)
        ? [node]
        : selectedCanvasNodes(canvas).filter(item => item.output && isRenderableImageOutput(item.output)).slice(0, 1);
      if (!sources.length && canvas.nodes?.length) {
        showToast('请先选择一个已生成节点作为参考');
        return;
      }
      const prompt = dom.imagePrompt.value.trim() || defaultCanvasPrompt('branch', sources);
      const reviewNode = addImageCanvasReviewNode(canvas, {
        prompt,
        params: saveImageParams(),
        operation: 'branch',
        sources,
        inputImages: sources.length ? [] : state.imageRefs,
      });
      if (reviewNode) {
        saveImageCanvas(canvas);
        renderImageWorkspace();
        updateImageGenerateBtn();
        requestAnimationFrame(() => {
          dom.imageCanvasWorkspace?.querySelector(`.image-canvas-node-prompt-input[data-node="${CSS.escape(reviewNode.id)}"]`)?.focus();
        });
      }
      return;
    }
    if (action === 'canvas-optimize' || action === 'canvas-optimize-node') {
      if (!canvas) return;
      const sources = node?.output && isRenderableImageOutput(node.output)
        ? [node]
        : selectedCanvasNodes(canvas).filter(item => item.output && isRenderableImageOutput(item.output)).slice(0, 1);
      if (!sources.length) {
        showToast('请先选择一个已生成节点');
        return;
      }
      const reviewNode = addImageCanvasReviewNode(canvas, {
        prompt: dom.imagePrompt.value.trim() || defaultCanvasPrompt('optimize', sources),
        params: saveImageParams(),
        operation: 'optimize',
        sources,
      });
      saveImageCanvas(canvas);
      renderImageWorkspace();
      updateImageGenerateBtn();
      requestAnimationFrame(() => {
        dom.imageCanvasWorkspace?.querySelector(`.image-canvas-node-prompt-input[data-node="${CSS.escape(reviewNode.id)}"]`)?.focus();
      });
      return;
    }
    if (action === 'canvas-merge') {
      if (!canvas || selected.length < 2) {
        showToast('请至少选择两个已生成节点再合并');
        return;
      }
      const reviewNode = addImageCanvasReviewNode(canvas, {
        prompt: dom.imagePrompt.value.trim() || defaultCanvasPrompt('merge', selected),
        params: saveImageParams(),
        operation: 'merge',
        sources: selected,
      });
      saveImageCanvas(canvas);
      renderImageWorkspace();
      updateImageGenerateBtn();
      requestAnimationFrame(() => {
        dom.imageCanvasWorkspace?.querySelector(`.image-canvas-node-prompt-input[data-node="${CSS.escape(reviewNode.id)}"]`)?.focus();
      });
    }
  }

  function handleImageCanvasPointerDown(e) {
    if (!state.imageCanvasMode || e.target.closest('.image-canvas-action, input, textarea, select')) return;
    const canvas = currentImageCanvas();
    const stage = e.target.closest('.image-canvas-stage');
    if (!stage) return;
    const nodeEl = e.target.closest('.image-canvas-node');
    if (nodeEl && canvas) {
      const node = canvas.nodes.find(item => item.id === nodeEl.dataset.node);
      if (!node) return;
      e.preventDefault();
      if (state.imageCanvasConnectFrom && state.imageCanvasConnectFrom !== node.id) {
        connectImageCanvasNodes(canvas, state.imageCanvasConnectFrom, node.id);
        return;
      }
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      setImageCanvasNodeSelection(canvas, node.id, additive);
      nodeEl.classList.toggle('selected', (canvas.selectedNodeIds || []).includes(node.id));
      const movedIds = new Set(canvas.selectedNodeIds || []);
      if (!movedIds.has(node.id)) movedIds.add(node.id);
      const startNodes = [...movedIds]
        .map(id => canvas.nodes.find(item => item.id === id))
        .filter(Boolean)
        .map(item => ({ id: item.id, x: Number(item.x) || 0, y: Number(item.y) || 0 }));
      state.imageCanvasPointer = {
        type: 'node',
        canvasId: canvas.id,
        nodeId: node.id,
        nodeIds: [...movedIds],
        startNodes,
        startX: e.clientX,
        startY: e.clientY,
        nodeX: Number(node.x) || 0,
        nodeY: Number(node.y) || 0,
        before: imageCanvasSnapshot(canvas),
        moved: false,
      };
      return;
    }
    if (canvas && state.imageCanvasSelectedEdgeId) {
      state.imageCanvasSelectedEdgeId = null;
    }
    e.preventDefault();
    const vp = canvasViewport(canvas);
    if (e.shiftKey && canvas) {
      const rect = stage.getBoundingClientRect();
      const startCanvasX = (e.clientX - rect.left - vp.x) / (vp.zoom || 1);
      const startCanvasY = (e.clientY - rect.top - vp.y) / (vp.zoom || 1);
      state.imageCanvasPointer = {
        type: 'select',
        canvasId: canvas.id,
        startX: e.clientX,
        startY: e.clientY,
        canvasX: startCanvasX,
        canvasY: startCanvasY,
        currentX: e.clientX,
        currentY: e.clientY,
      };
      const box = document.createElement('div');
      box.className = 'image-canvas-selection-box';
      box.style.left = `${e.clientX - rect.left}px`;
      box.style.top = `${e.clientY - rect.top}px`;
      stage.appendChild(box);
      return;
    }
    state.imageCanvasPointer = {
      type: 'pan',
      canvasId: canvas?.id || '',
      startX: e.clientX,
      startY: e.clientY,
      viewX: vp.x,
      viewY: vp.y,
    };
    stage.classList.add('is-dragging');
  }

  function handleImageCanvasPointerMove(e) {
    const pointer = state.imageCanvasPointer;
    if (!pointer) return;
    const canvas = currentImageCanvas();
    if (!canvas || canvas.id !== pointer.canvasId) return;
    e.preventDefault();
    if (pointer.type === 'node') {
      const zoom = canvasViewport(canvas).zoom || 1;
      const dx = Math.round((e.clientX - pointer.startX) / zoom);
      const dy = Math.round((e.clientY - pointer.startY) / zoom);
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) pointer.moved = true;
      (pointer.startNodes || []).forEach(start => {
        const node = canvas.nodes.find(item => item.id === start.id);
        if (!node) return;
        node.x = start.x + dx;
        node.y = start.y + dy;
        const nodeEl = dom.imageCanvasWorkspace?.querySelector(`.image-canvas-node[data-node="${CSS.escape(node.id)}"]`);
        if (nodeEl) {
          nodeEl.style.left = `${node.x}px`;
          nodeEl.style.top = `${node.y}px`;
        }
      });
      return;
    }
    if (pointer.type === 'select') {
      const stage = dom.imageCanvasWorkspace?.querySelector('.image-canvas-stage');
      const box = dom.imageCanvasWorkspace?.querySelector('.image-canvas-selection-box');
      if (!stage || !box) return;
      pointer.currentX = e.clientX;
      pointer.currentY = e.clientY;
      const rect = stage.getBoundingClientRect();
      const left = Math.min(pointer.startX, e.clientX) - rect.left;
      const top = Math.min(pointer.startY, e.clientY) - rect.top;
      const width = Math.abs(e.clientX - pointer.startX);
      const height = Math.abs(e.clientY - pointer.startY);
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
      return;
    }
    if (pointer.type === 'pan') {
      const vp = canvasViewport(canvas);
      canvas.viewport = Object.assign({}, vp, {
        x: pointer.viewX + e.clientX - pointer.startX,
        y: pointer.viewY + e.clientY - pointer.startY,
      });
      const plane = dom.imageCanvasWorkspace?.querySelector('.image-canvas-plane');
      if (plane) plane.style.transform = `translate(${canvas.viewport.x}px, ${canvas.viewport.y}px) scale(${canvas.viewport.zoom})`;
    }
  }

  function handleImageCanvasPointerUp() {
    const pointer = state.imageCanvasPointer;
    if (!pointer) return;
    state.imageCanvasPointer = null;
    const canvas = currentImageCanvas();
    const stage = dom.imageCanvasWorkspace?.querySelector('.image-canvas-stage');
    stage?.classList.remove('is-dragging');
    if (canvas && canvas.id === pointer.canvasId) {
      if (pointer.type === 'node' && pointer.moved) {
        if (pointer.before) {
          canvas.history.push(pointer.before);
          if (canvas.history.length > 40) canvas.history.shift();
        }
        canvas.future = [];
      }
      if (pointer.type === 'select') {
        const vp = canvasViewport(canvas);
        const rect = stage?.getBoundingClientRect();
        const box = dom.imageCanvasWorkspace?.querySelector('.image-canvas-selection-box');
        if (rect) {
          const endX = Number.isFinite(pointer.currentX) ? pointer.currentX : pointer.startX;
          const endY = Number.isFinite(pointer.currentY) ? pointer.currentY : pointer.startY;
          const endCanvasX = (endX - rect.left - vp.x) / (vp.zoom || 1);
          const endCanvasY = (endY - rect.top - vp.y) / (vp.zoom || 1);
          const minX = Math.min(pointer.canvasX, endCanvasX);
          const minY = Math.min(pointer.canvasY, endCanvasY);
          const maxX = Math.max(pointer.canvasX, endCanvasX);
          const maxY = Math.max(pointer.canvasY, endCanvasY);
          canvas.selectedNodeIds = (canvas.nodes || []).filter(node => {
            const r = imageCanvasNodeRect(node);
            return r.x < maxX && r.x + r.w > minX && r.y < maxY && r.y + r.h > minY;
          }).map(node => node.id);
        }
        box?.remove();
      }
      saveImageCanvas(canvas, { sidebar: false });
      renderImageWorkspace();
      updateImageGenerateBtn();
    }
  }

  function handleImageCanvasWheel(e) {
    if (!state.imageCanvasMode || !e.target.closest('.image-canvas-stage')) return;
    const canvas = currentImageCanvas();
    if (!canvas) return;
    e.preventDefault();
    const stage = e.target.closest('.image-canvas-stage');
    const rect = stage.getBoundingClientRect();
    const vp = canvasViewport(canvas);
    const factor = e.deltaY > 0 ? .9 : 1.1;
    const nextZoom = Math.min(2.4, Math.max(.28, vp.zoom * factor));
    const worldX = (e.clientX - rect.left - vp.x) / vp.zoom;
    const worldY = (e.clientY - rect.top - vp.y) / vp.zoom;
    canvas.viewport = {
      x: e.clientX - rect.left - worldX * nextZoom,
      y: e.clientY - rect.top - worldY * nextZoom,
      zoom: nextZoom,
    };
    const plane = dom.imageCanvasWorkspace?.querySelector('.image-canvas-plane');
    if (plane) plane.style.transform = `translate(${canvas.viewport.x}px, ${canvas.viewport.y}px) scale(${canvas.viewport.zoom})`;
    scheduleImageCanvasViewportSave(canvas);
  }

  function handleImageCanvasKeydown(e) {
    if (!state.imageCanvasMode || !currentImageCanvas()) return;
    if (e.target?.closest?.('input, textarea, select')) return;
    const canvas = currentImageCanvas();
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (state.imageCanvasConnectFrom) {
        state.imageCanvasConnectFrom = null;
        renderImageWorkspace();
        showToast('已取消连线');
        return;
      }
      if (state.imageCanvasSelectedEdgeId) {
        state.imageCanvasSelectedEdgeId = null;
        saveImageCanvas(canvas, { sidebar: false });
        renderImageWorkspace();
        updateImageGenerateBtn();
        return;
      }
      handleImageCanvasAction('canvas-exit', null);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.imageCanvasSelectedEdgeId) {
      e.preventDefault();
      disconnectImageCanvasEdge(canvas);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedCanvasNodes(canvas).length) {
      e.preventDefault();
      handleImageCanvasAction('canvas-delete-selected', null);
      return;
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redoImageCanvas(canvas);
      else undoImageCanvas(canvas);
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redoImageCanvas(canvas);
    }
  }

  function handleImageCanvasTaskInput(e) {
    const plannerField = e.target.closest('.image-canvas-planner-topic, .image-canvas-planner-template, .image-canvas-planner-complexity');
    if (plannerField) {
      syncImageCanvasPlannerDraft();
      return;
    }
    const nodeTitleInput = e.target.closest('.image-canvas-node-title-input');
    const nodePromptInput = e.target.closest('.image-canvas-node-prompt-input');
    if (nodeTitleInput || nodePromptInput) {
      const input = nodeTitleInput || nodePromptInput;
      const canvas = currentImageCanvas();
      const node = canvas?.nodes?.find(item => item.id === input.dataset.node);
      if (!node) return;
      if (nodeTitleInput) node.title = nodeTitleInput.value.trim();
      if (nodePromptInput) node.prompt = nodePromptInput.value.trim();
      saveImageCanvas(canvas, { sidebar: false });
      return;
    }
    const input = e.target.closest('.image-canvas-task-title, .image-canvas-task-prompt');
    if (!input) return;
    const canvas = currentImageCanvas();
    const index = parseInt(input.dataset.task || '-1', 10);
    const task = canvas?.plan?.tasks?.[index];
    if (!task) return;
    if (input.classList.contains('image-canvas-task-title')) task.title = input.value.trim();
    if (input.classList.contains('image-canvas-task-prompt')) task.prompt = input.value.trim();
    saveImageCanvas(canvas, { sidebar: false });
  }

  function handleImageCanvasInputKeydown(e) {
    const plannerTopic = e.target.closest('.image-canvas-planner-topic');
    if (plannerTopic && e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      submitImageCanvasPlanner(currentImageCanvas());
      return;
    }
    if (state.imageCanvasPlannerOpen && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeImageCanvasPlanner();
    }
  }

  async function updateRemoteImageOutputMeta(job, out, metaEl) {
    if (!out?.url || out.metaFetchTried || out.bytes) return;
    out.metaFetchTried = true;
    try {
      const resp = await fetch(out.url, { mode: 'cors' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      out.bytes = blob.size || 0;
      if (blob.type) out.format = normalizeImageFormat(blob.type);
      imageDbPutJob(job);
      if (metaEl) metaEl.innerHTML = imageOutputMeta(out, job.params?.outputFormat).map(esc).join('<span>·</span>');
    } catch {
      if (metaEl) metaEl.innerHTML = imageOutputMeta(out, job.params?.outputFormat).map(esc).join('<span>·</span>');
    }
  }

  function updateImageOutputMeta(jobId, index, img) {
    const job = state.imageJobs.find(j => j.id === jobId);
    const resultEl = img?.closest?.('.image-result');
    const replyIndex = parseInt(resultEl?.dataset.reply || '0', 10);
    const { reply, out } = imageReplyOutput(job, replyIndex, index);
    if (!job || !out || !img?.naturalWidth || !img?.naturalHeight) return;
    const nextWidth = img.naturalWidth;
    const nextHeight = img.naturalHeight;
    if (out.width === nextWidth && out.height === nextHeight && out.bytes) return;
    out.width = nextWidth;
    out.height = nextHeight;
    out.bytes = imageByteSize(out);
    imageDbPutJob(job);
    const metaEl = resultEl?.querySelector('.image-result-meta');
    if (metaEl) metaEl.innerHTML = imageOutputMeta(out, (reply?.params || job.params)?.outputFormat).map(esc).join('<span>·</span>');
    updateRemoteImageOutputMeta(job, out, metaEl);
  }

  function downloadImage(job, out) {
    const a = document.createElement('a');
    a.href = dataUrlForImage(out, job.params?.outputFormat);
    a.download = imageFilename(job, out);
    if (out.url) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    a.click();
  }

  async function copyImage(job, out) {
    if (out.url && !out.b64) {
      copyText(out.url);
      showToast('已复制图片链接');
      return;
    }
    if (!navigator.clipboard || !window.ClipboardItem) {
      showToast('当前浏览器不支持直接复制图片');
      return;
    }
    try {
      const src = dataUrlForImage(out, job.params?.outputFormat);
      const blob = src.startsWith('data:')
        ? await (await fetch(src)).blob()
        : await (await fetch(src, { mode: 'cors' })).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      showToast('图片已复制');
    } catch {
      showToast('复制图片失败，可先下载');
    }
  }

  function downloadAttachmentImage(item) {
    const a = document.createElement('a');
    a.href = item.src;
    a.download = attachmentImageFilename(item);
    a.click();
  }

  async function copyAttachmentImage(item) {
    if (!navigator.clipboard || !window.ClipboardItem) {
      showToast('当前浏览器不支持直接复制图片');
      return;
    }
    try {
      const blob = await (await fetch(item.src)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      showToast('图片已复制');
    } catch {
      showToast('复制图片失败，可先下载');
    }
  }

  function openImageViewer(job, out, replyIndex = 0) {
    const scope = out.inputRef ? 'inputs' : 'outputs';
    const items = ImageCore.imageViewerItemsForJob(job, scope, MAX_IMAGE_REFS);
    const reply = imageJobReplies(job)[replyIndex];
    let itemIndex = items.findIndex(item => {
      if (out.inputRef) return item.inputRef && item.replyIndex === replyIndex && item.refIndex === (out.refIndex || 0);
      return !item.inputRef && item.replyIndex === replyIndex && item.out === out;
    });
    if (itemIndex < 0 && !out.inputRef) {
      const outputIndex = reply?.outputs?.indexOf(out) ?? 0;
      itemIndex = items.findIndex(item => !item.inputRef && item.replyIndex === replyIndex && item.index === outputIndex);
    }
    ImageViewer.openItems(items, itemIndex);
  }

  function openAttachmentImageViewer(src, name = 'attachment') {
    ImageViewer.openAttachment({ src, name });
  }

  function currentViewerImage() {
    const item = ImageViewer.current();
    if (!item) return null;
    if (item.attachment) {
      const src = item.src;
      const mime = src.match(/^data:([^;]+)/)?.[1] || 'image/png';
      const format = normalizeImageFormat(mime) || 'png';
      return {
        attachment: true,
        src,
        name: item.name || `attachment.${format}`,
        format,
      };
    }
    const job = state.imageJobs.find(j => j.id === item.jobId);
    if (!job || !item.out) return null;
    if (item.nodeId && isImageCanvasJob(job)) {
      const node = (job.nodes || []).find(entry => entry.id === item.nodeId);
      if (node) {
        return {
          job: Object.assign({}, job, {
            title: node.title || job.title,
            params: node.params || job.params,
          }),
          out: item.out,
        };
      }
    }
    return { job, out: item.out };
  }

  function estimateImageSeconds(params) {
    return ImageCore.estimateImageSeconds(params, imageReferenceList());
  }

  function imageTimeoutMs(params) {
    return ImageCore.imageTimeoutMs(params, imageReferenceList());
  }

  function startImageProgressTimer() {
    stopImageProgressTimer();
    state.imageProgressTimer = setInterval(() => {
      if (isImageModeLike() && state.imageJobs.some(job => job.status === 'generating')) {
        updateImageProgressElapsed();
      }
    }, 1000);
  }

  function stopImageProgressTimer() {
    if (!state.imageProgressTimer) return;
    clearInterval(state.imageProgressTimer);
    state.imageProgressTimer = null;
  }

  function updateImageProgressElapsed() {
    if (state.mode !== 'image' || !dom.imageGallery) return;
    dom.imageGallery.querySelectorAll('.image-progress[data-job]').forEach(el => {
      const job = state.imageJobs.find(j => j.id === el.dataset.job);
      const elapsedEl = el.querySelector('.image-progress-elapsed');
      if (!job || !elapsedEl) return;
      elapsedEl.textContent = `耗时 ${formatDuration(Date.now() - (job.startedAt || job.createdAt || Date.now()))}`;
    });
  }

  async function requestImageWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      if (state.imageWakeLock) return;
      state.imageWakeLock = await navigator.wakeLock.request('screen');
      state.imageWakeLock.addEventListener('release', () => {
        state.imageWakeLock = null;
      });
    } catch {
      state.imageWakeLock = null;
    }
  }

  async function requestChatWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      if (state.chatWakeLock) return;
      state.chatWakeLock = await navigator.wakeLock.request('screen');
      state.chatWakeLock.addEventListener('release', () => {
        state.chatWakeLock = null;
      });
    } catch {
      state.chatWakeLock = null;
    }
  }

  async function releaseChatWakeLock() {
    const lock = state.chatWakeLock;
    state.chatWakeLock = null;
    if (!lock) return;
    try { await lock.release(); } catch { /* already released */ }
  }

  async function releaseImageWakeLock() {
    const lock = state.imageWakeLock;
    state.imageWakeLock = null;
    if (!lock) return;
    try { await lock.release(); } catch { /* already released */ }
  }

  function syncImageWakeLock() {
    if (state.isGeneratingImage && document.visibilityState === 'visible') {
      requestImageWakeLock();
    } else if (!state.isGeneratingImage) {
      releaseImageWakeLock();
    }
  }

  function hasActiveChatStream() {
    return !!state.streamingConvId || state.conversations.some(conv => conv.messages?.some(msg => msg.streaming));
  }

  function syncChatWakeLock() {
    if ((state.isStreaming || hasActiveChatStream()) && document.visibilityState === 'visible') {
      requestChatWakeLock();
    } else if (!state.isStreaming && !hasActiveChatStream()) {
      releaseChatWakeLock();
    }
  }

  function syncWakeLocks() {
    syncImageWakeLock();
    syncChatWakeLock();
  }

  async function cancelImageGeneration(reason = '已取消生成') {
    const job = state.imageJobs.find(j => j.status === 'generating');
    if (!job) return;
    if (state.imageAbortController) state.imageAbortController.abort();
    if (state.imageRetryContext?.jobId === job.id) {
      const { replyIndex, outputIndex } = state.imageRetryContext;
      const reply = imageJobReplies(job)[replyIndex];
      if (reply?.outputs?.[outputIndex]?.retrying) {
        reply.outputs[outputIndex] = Object.assign({}, reply.outputs[outputIndex], {
          failed: true,
          retrying: false,
          error: reason || '请求已中断',
          updatedAt: Date.now(),
        });
        job.outputs = reply.outputs;
        applyReplyProgressFromOutputs(job, reply, 1);
        finishImageReplyStatusFromOutputs(job, reply);
      }
      state.imageRetryContext = null;
      state.isGeneratingImage = false;
      state.imageAbortController = null;
      releaseImageWakeLock();
      stopImageProgressTimer();
      persist();
      imageDbPutJob(job);
      renderImageWorkspace();
      updateSidebar();
      updateImageGenerateBtn();
      return;
    }
    if (state.imagePollTimer) {
      clearInterval(state.imagePollTimer);
      state.imagePollTimer = null;
    }
    const activeReply = currentImageActiveReply(job);
    if (activeReply) setImageJobFailed(job, activeReply, reason, 'cancelled');
    state.isGeneratingImage = false;
    state.imageAbortController = null;
    releaseImageWakeLock();
    stopImageProgressTimer();
    persist();
    imageDbPutJob(job);
    renderImageWorkspace();
    updateSidebar();
    updateImageGenerateBtn();
    await writeImageSession({
      id: IMAGE_KEY,
      jobId: job.id,
      status: 'stopped',
      updatedAt: Date.now(),
      error: reason,
    });
    setTimeout(() => clearImageSessionForJob(job.id, ['stopped']), 1000);
  }

  function storageText(bytes) {
    return Attachments.formatBytes(bytes) || '0 B';
  }

  function isSettingsOpen() {
    return dom.settingsModal && !dom.settingsModal.classList.contains('hidden');
  }

  async function collectStorageStats() {
    const chatJson = localStorage.getItem(KEYS.conversations) || '[]';
    const allFiles = await fileDbGetAll();
    const attachmentBytes = allFiles.reduce((sum, file) => sum + Attachments.storedTextBytes(file), 0);
    const attachmentIds = new Set(allFiles.map(file => file?.id).filter(Boolean));
    const referencedIds = new Set(collectConversationFileIds(state.conversations));
    const orphanAttachmentCount = allFiles.reduce((sum, file) => {
      return sum + (file?.id && !referencedIds.has(file.id) ? 1 : 0);
    }, 0);
    const jobs = state.imageJobs.length ? state.imageJobs : await imageDbGetAllJobs();
    const outputCount = jobs.reduce((sum, job) => {
      return sum + imageJobReplies(job).reduce((n, reply) => {
        const total = Math.max(1, Number(reply?.progress?.total) || Number(reply?.params?.count) || Number(job?.params?.count) || (reply.outputs || []).length || 1);
        return n + (reply.outputs || []).slice(0, total).filter(isRenderableImageOutput).length;
      }, 0);
    }, 0);
    const estimate = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => null) : null;
    const quotaUsage = Number(estimate?.usage) || 0;
    const quotaBytes = Number(estimate?.quota) || 0;
    return {
      conversationCount: state.conversations.length,
      chatBytes: Attachments.storedTextBytes(chatJson) + attachmentBytes,
      attachmentCount: attachmentIds.size,
      orphanAttachmentCount,
      imageJobCount: jobs.length,
      imageOutputCount: outputCount,
      imageBytes: Attachments.storedTextBytes(jobs),
      quotaUsage,
      quotaBytes,
      quotaRatio: quotaBytes ? quotaUsage / quotaBytes : 0,
      persisted,
    };
  }

  async function updateStorageStats() {
    if (!dom.chatStorageSummary || !dom.imageStorageSummary) return;
    const browserSummaries = [dom.browserStorageSummaryChat, dom.browserStorageSummaryImage].filter(Boolean);
    const persistButtons = [dom.requestPersistentStorageChat, dom.requestPersistentStorageImage].filter(Boolean);
    const token = Date.now();
    state.storageStatsToken = token;
    dom.chatStorageSummary.textContent = '正在统计...';
    dom.imageStorageSummary.textContent = '正在统计...';
    browserSummaries.forEach(el => { el.textContent = '正在统计...'; });
    persistButtons.forEach(btn => { btn.disabled = true; });
    try {
      const stats = await collectStorageStats();
      if (state.storageStatsToken !== token) return;
      const orphanText = stats.orphanAttachmentCount ? `，待清理附件 ${stats.orphanAttachmentCount} 个` : '';
      const quotaText = stats.quotaBytes
        ? `${storageText(stats.quotaUsage)} / ${storageText(stats.quotaBytes)}（${Math.round(stats.quotaRatio * 100)}%）`
        : '当前浏览器未返回配额信息';
      const persistedText = stats.persisted === null ? '' : `，持久化${stats.persisted ? '已开启' : '未开启'}`;
      const quotaWarn = stats.quotaRatio >= 0.8;
      browserSummaries.forEach(el => el.classList.toggle('is-warning', quotaWarn));
      dom.chatStorageSummary.classList.remove('is-warning');
      dom.imageStorageSummary.classList.remove('is-warning');
      dom.chatStorageSummary.textContent = `${stats.conversationCount} 条对话，附件 ${stats.attachmentCount} 个${orphanText}，占用 ${storageText(stats.chatBytes)}`;
      dom.imageStorageSummary.textContent = `${stats.imageJobCount} 条绘画，图片 ${stats.imageOutputCount} 张，占用 ${storageText(stats.imageBytes)}`;
      browserSummaries.forEach(el => {
        el.textContent = `${quotaText}${persistedText}${quotaWarn ? '，建议清理历史图片或对话附件' : ''}`;
      });
      persistButtons.forEach(btn => {
        const unsupported = !navigator.storage?.persist;
        btn.disabled = unsupported || stats.persisted === true;
        btn.textContent = unsupported ? '不支持' : (stats.persisted ? '已开启' : '申请持久化');
      });
    } catch (e) {
      console.warn('Storage stats failed:', e);
      if (state.storageStatsToken !== token) return;
      dom.chatStorageSummary.textContent = '统计失败';
      dom.imageStorageSummary.textContent = '统计失败';
      browserSummaries.forEach(el => { el.textContent = '统计失败'; });
      persistButtons.forEach(btn => { btn.disabled = !navigator.storage?.persist; });
    }
  }

  function updateStorageStatsIfOpen() {
    if (isSettingsOpen()) updateStorageStats();
  }

  async function clearChatStorage() {
    if (!confirm('确认清空全部对话和附件存储？此操作不可恢复。')) return;
    dom.clearChatStorage.disabled = true;
    pauseActivePolls();
    try {
      if (state.chatAbortController) state.chatAbortController.abort();
      state.isStreaming = false;
      state.streamingConvId = null;
      state.chatAbortController = null;
      releaseChatWakeLock();
      await clearStreamSession();
      state.conversations = [];
      state.currentConvId = null;
      resetSidebarBulkMode();
      persist([KEYS.conversations, KEYS.currentConvId]);
      await fileDbClearAll();
      updateSidebar();
      syncConvParams();
      renderMessages();
      updateSendBtn();
      updateInputState();
      updateStorageStats();
      showToast('对话已清空');
    } finally {
      dom.clearChatStorage.disabled = false;
    }
  }

  async function clearImageStorage() {
    if (!confirm('确认清空全部绘画记录？此操作不可恢复。')) return;
    dom.clearImageStorage.disabled = true;
    try {
      if (state.imageAbortController) state.imageAbortController.abort();
      if (state.imagePollTimer) {
        clearInterval(state.imagePollTimer);
        state.imagePollTimer = null;
      }
      state.isGeneratingImage = false;
      state.imageAbortController = null;
      releaseImageWakeLock();
      stopImageProgressTimer();
      await clearImageSession();
      state.imageJobs = [];
      state.currentImageJobId = null;
      state.imageCanvasMode = false;
      document.body.classList.remove('image-canvas-open');
      setImageReferences([]);
      resetSidebarBulkMode();
      persist([KEYS.currentImageJobId, KEYS.imageCanvasMode]);
      await imageDbClearJobs();
      updateSidebar();
      renderImageRefPreview();
      renderImageWorkspace();
      updateImageGenerateBtn();
      updateStorageStats();
      showToast('绘画记录已清空');
    } finally {
      dom.clearImageStorage.disabled = false;
    }
  }

  async function requestPersistentStorage() {
    const persistButtons = [dom.requestPersistentStorageChat, dom.requestPersistentStorageImage].filter(Boolean);
    if (!navigator.storage?.persist) {
      showToast('当前浏览器不支持持久化存储申请');
      updateStorageStatsIfOpen();
      return;
    }
    persistButtons.forEach(btn => { btn.disabled = true; });
    try {
      const granted = await navigator.storage.persist();
      showToast(granted ? '持久化存储已开启' : '浏览器未批准持久化存储');
    } catch (e) {
      console.warn('Persistent storage request failed:', e);
      showToast('持久化存储申请失败');
    } finally {
      updateStorageStatsIfOpen();
    }
  }

  function imageOutputStats(outputs = []) {
    return {
      success: outputs.filter(isRenderableImageOutput).length,
      failed: outputs.filter(out => out?.failed && !out.retrying).length,
      retrying: outputs.filter(out => out?.retrying).length,
    };
  }

  function applyReplyProgressFromOutputs(job, reply, maxParallel = 1) {
    const outputs = reply?.outputs || [];
    const stats = imageOutputStats(outputs);
    const total = Math.max(1, Number(reply?.params?.count) || Number(job?.params?.count) || outputs.length || 1);
    const progress = {
      total,
      completed: Math.min(total, stats.success + stats.failed),
      success: stats.success,
      failed: stats.failed,
      maxParallel,
    };
    reply.progress = progress;
    job.progress = progress;
    return progress;
  }

  function finishImageReplyStatusFromOutputs(job, reply, startedAt = null) {
    const stats = imageOutputStats(reply.outputs || []);
    const durationMs = ImageCore.imageJobDuration(job, reply, startedAt);
    reply.durationMs = durationMs;
    job.durationMs = durationMs;
    if (stats.success > 0) {
      reply.status = 'done';
      reply.error = null;
      job.status = 'done';
      job.error = null;
    } else {
      reply.status = 'error';
      reply.error = reply.outputs?.find(out => out?.failed)?.error || '生成失败';
      job.status = 'error';
      job.error = reply.error;
    }
  }

  async function retryFailedImageInPlace(job, replyIndex, outputIndex) {
    if (state.isGeneratingImage || job.status === 'generating') {
      showToast('当前已有绘画任务进行中');
      return;
    }
    const reply = imageJobReplies(job)[Number.isFinite(replyIndex) ? replyIndex : 0];
    const failed = reply?.outputs?.[Number.isFinite(outputIndex) ? outputIndex : -1];
    if (!reply || !failed?.failed) return;

    const startedAt = Date.now();
    const params = sanitizeCurrentImageParams(Object.assign({}, DEFAULT_IMAGE_PARAMS, job.params || {}, reply.params || {}, { count: 1 }));
    const refs = imageReferencePayload(reply.inputImages || job.inputImages || null);
    const controller = new AbortController();
    const previousJobStartedAt = job.startedAt;
    const previousReplyStartedAt = reply.startedAt;
    const previousFailed = Object.assign({}, failed);

    state.isGeneratingImage = true;
    state.imageAbortController = controller;
    state.imageRetryContext = { jobId: job.id, replyIndex, outputIndex };
    requestImageWakeLock();
    startImageProgressTimer();

    job.status = 'generating';
    job.startedAt = startedAt;
    reply.status = 'generating';
    reply.startedAt = startedAt;
    reply.outputs[outputIndex] = Object.assign({}, previousFailed, {
      failed: true,
      retrying: true,
      error: '',
      retryStartedAt: startedAt,
    });
    applyReplyProgressFromOutputs(job, reply, 1);
    persist();
    imageDbPutJob(job);
    updateSidebar();
    renderImageWorkspace();
    updateImageGenerateBtn();

    const requestSingleImage = () => state.imageMapModel
      ? ImageApi.requestMappedImage(imageMapEndpoint(), reply.prompt || job.prompt || '', params, refs, controller.signal)
      : refs.length
        ? ImageApi.requestImageEdit(effectiveImageEndpoint(), state.imageModel, reply.prompt || job.prompt || '', params, refs, controller.signal)
        : ImageApi.requestOneImage(effectiveImageEndpoint(), state.imageModel, reply.prompt || job.prompt || '', params, controller.signal);

    try {
      const result = await requestSingleImage();
      const nextOutput = ImageCore.imageResultOutputs(result)[0];
      if (!nextOutput) throw new Error('接口未返回可显示的图片数据');
      reply.outputs[outputIndex] = Object.assign({}, nextOutput, {
        requestIndex: Number.isFinite(previousFailed.requestIndex) ? previousFailed.requestIndex : outputIndex,
        retriedAt: Date.now(),
      });
      const nextUsage = ImageCore.imageResultUsage(result);
      reply.usage = ImageCore.combineImageUsages([reply.usage, nextUsage]);
      job.outputs = reply.outputs;
      job.usage = reply.usage;
      applyReplyProgressFromOutputs(job, reply, 1);
      finishImageReplyStatusFromOutputs(job, reply, startedAt);
      showToast('失败图片已重试完成');
    } catch (e) {
      const aborted = e?.name === 'AbortError';
      reply.outputs[outputIndex] = Object.assign({}, previousFailed, {
        failed: true,
        retrying: false,
        error: aborted ? '请求已中断' : String(e.message || e || '生成失败'),
        updatedAt: Date.now(),
      });
      job.outputs = reply.outputs;
      applyReplyProgressFromOutputs(job, reply, 1);
      finishImageReplyStatusFromOutputs(job, reply, startedAt);
      showToast(aborted ? '重试已中断' : '重试失败');
    } finally {
      if (state.imageRetryContext?.jobId === job.id) state.imageRetryContext = null;
      state.isGeneratingImage = false;
      state.imageAbortController = null;
      job.startedAt = previousJobStartedAt || job.startedAt;
      reply.startedAt = previousReplyStartedAt || reply.startedAt;
      releaseImageWakeLock();
      stopImageProgressTimer();
      persist();
      imageDbPutJob(job);
      updateSidebar();
      renderImageWorkspace();
      scrollImageWorkspaceToBottom(false);
      updateImageGenerateBtn();
    }
  }

  function renderImageWorkspace() {
    const selected = currentImageJob();
    const isLoading = state.isImageHistoryLoading;
    const showCanvas = state.mode === 'image' && state.imageCanvasMode && canUseImageCanvas() && isImageCanvasJob(selected);
    state.imageCanvasMode = showCanvas;
    if (dom.imageCanvasToggleBtn) dom.imageCanvasToggleBtn.classList.toggle('active', showCanvas);
    if (dom.imageWorkspace) dom.imageWorkspace.classList.toggle('canvas-mode', showCanvas);
    document.body.classList.toggle('image-canvas-open', showCanvas);
    dom.imageInputArea?.classList.toggle('hidden', state.mode !== 'image' || showCanvas);
    dom.imageCanvasWorkspace?.classList.toggle('hidden', !showCanvas);
    dom.imageGallery?.classList.toggle('hidden', showCanvas);
    dom.imageEmpty.classList.toggle('hidden', showCanvas || isLoading || !!selected);
    if (showCanvas) {
      dom.imageCanvasWorkspace.innerHTML = renderImageCanvasWorkspace();
      dom.imageCanvasWorkspace.querySelectorAll('button[title]:not([data-tooltip])').forEach(btn => { btn.dataset.tooltip = btn.title; });
      return;
    }
    if (dom.imageCanvasWorkspace) dom.imageCanvasWorkspace.innerHTML = '';
    dom.imageGallery.innerHTML = ImageRenderer.renderWorkspace(isImageCanvasJob(selected) ? null : selected, {
      isLoading,
      defaultParams: DEFAULT_IMAGE_PARAMS,
      maxRefs: MAX_IMAGE_REFS,
      formatSourcedModel,
      icons: {
        person: Icons.person,
        copy: Icons.copy,
        edit: Icons.edit,
        download: Icons.download,
        maximize: Icons.maximize,
        refresh: Icons.refresh,
      },
    }).html;
  }

  let imageWorkspaceRenderFrame = null;
  let imageWorkspaceRenderShouldScroll = false;
  function scheduleImageWorkspaceRender(opts = {}) {
    imageWorkspaceRenderShouldScroll = imageWorkspaceRenderShouldScroll || !!opts.scroll;
    if (imageWorkspaceRenderFrame) return;
    const schedule = window.requestAnimationFrame || (fn => setTimeout(fn, 16));
    imageWorkspaceRenderFrame = schedule(() => {
      imageWorkspaceRenderFrame = null;
      const shouldScroll = imageWorkspaceRenderShouldScroll;
      imageWorkspaceRenderShouldScroll = false;
      renderImageWorkspace();
      if (shouldScroll) scrollImageWorkspaceToBottom(false);
    });
  }

  function scrollImageWorkspaceToBottom(smooth = true) {
    if (state.mode !== 'image' || !dom.imageWorkspace) return;
    const scroll = () => {
      if (state.mode !== 'image' || !dom.imageWorkspace) return;
      dom.imageWorkspace.scrollTo({
        top: dom.imageWorkspace.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
    };
    requestAnimationFrame(scroll);
    requestAnimationFrame(() => requestAnimationFrame(scroll));
    if (!smooth) {
      setTimeout(scroll, 80);
      setTimeout(scroll, 250);
    }
  }

  function isImageWorkspaceNearBottom(threshold = 120) {
    if (!dom.imageWorkspace) return true;
    return dom.imageWorkspace.scrollHeight - dom.imageWorkspace.scrollTop - dom.imageWorkspace.clientHeight <= threshold;
  }

  async function optimizeImagePrompt() {
    if (!imagePromptOptimizerConfigured()) {
      showSettings('image');
      showToast('请先配置提示词优化模型');
      return;
    }
    const prompt = dom.imagePrompt.value.trim();
    if (!prompt || state.isOptimizingImagePrompt || state.isGeneratingImage) return;
    const endpoint = imagePromptEndpoint();
    const model = endpoint.model;
    state.isOptimizingImagePrompt = true;
    updateImageGenerateBtn();
    showToast('正在优化提示词...');
    try {
      const optimized = await ImageApi.optimizePrompt({ baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, model }, prompt);
      if (!optimized) throw new Error('接口未返回优化后的提示词');
      dom.imagePrompt.value = optimized;
      saveImageParams();
      updateImageGenerateBtn();
      showToast('提示词已优化');
    } catch (e) {
      showToast('优化失败');
      alert(`优化提示词失败: ${e.message}\n\n请确认“提示词优化模型”支持 /chat/completions，并且对应的对话或绘画 Base URL 与 API Key 可用。`);
    } finally {
      state.isOptimizingImagePrompt = false;
      updateImageGenerateBtn();
    }
  }

  function createImageReply(jobId, prompt, params, refs, startedAt, replyId = `${jobId}-reply-${Date.now()}`) {
    return ImageCore.createImageReply({
      jobId,
      prompt,
      params,
      refs,
      startedAt,
      model: state.imageModel,
      mapModel: state.imageMapModel,
      replyId,
    });
  }

  async function generateImage(prompt, params = state.imageDefaults, retryJob = null, refOverride = undefined) {
    if (!ensureModeConfigured('image')) return;
    if (!imageMapConfigured()) {
      showSettings('image');
      showToast('请完善映射模型对应的接口配置');
      return;
    }
    if (!prompt.trim() || state.isGeneratingImage) return;
    params = sanitizeCurrentImageParams(params);

    state.isGeneratingImage = true;
    const controller = new AbortController();
    state.imageAbortController = controller;
    requestImageWakeLock();
    updateImageGenerateBtn();
    const startedAt = Date.now();
    const refSource = refOverride !== undefined ? refOverride : state.imageRefs;
    const refs = imageReferencePayload(refSource);
    const requestCount = Math.max(1, Math.min(MAX_IMAGE_COUNT, Number(params.count) || 1));
    params.count = requestCount;
    const estimatedSeconds = estimateImageSeconds(params);
    const job = retryJob || {
      id: startedAt.toString(),
      title: prompt.trim().slice(0, 30) + (prompt.trim().length > 30 ? '...' : ''),
      prompt: prompt.trim(),
      model: state.imageModel,
      mapModel: state.imageMapModel,
      createdAt: startedAt,
      params: Object.assign({}, params),
      inputImages: refs,
      outputs: [],
      error: null,
      status: 'generating',
      startedAt,
      estimatedSeconds,
      durationMs: null,
    };
    if (!job.replies) job.replies = [];
    let activeReply = null;
    if (!retryJob) {
      activeReply = createImageReply(job.id, prompt, params, refs, startedAt, `${job.id}-reply-0`);
      job.replies = [activeReply];
      state.imageJobs.unshift(job);
      state.currentImageJobId = job.id;
    } else {
      job.model = state.imageModel;
      job.mapModel = state.imageMapModel;
      job.params = Object.assign({}, params);
      job.error = null;
      job.status = 'generating';
      job.startedAt = startedAt;
      job.estimatedSeconds = estimatedSeconds;
      job.durationMs = null;
      activeReply = createImageReply(job.id, prompt, params, refs, startedAt);
      job.replies.push(activeReply);
    }
    const initialProgress = {
      total: requestCount,
      completed: 0,
      success: 0,
      failed: 0,
      maxParallel: Math.min(requestCount, 5),
    };
    activeReply.progress = initialProgress;
    job.progress = initialProgress;
    persist();
    imageDbPutJob(job);
    updateSidebar();
    renderImageWorkspace();
    scrollImageWorkspaceToBottom();
    startImageProgressTimer();
    let timeoutId = null;
    const requestTimeoutMs = imageTimeoutMs(params);
    const failImageJob = (message, status = 'error') => {
      failImageJobFromSession(job, activeReply, message, status, startedAt);
    };

    function finishImageJob() {
      state.isGeneratingImage = false;
      state.imageAbortController = null;
      releaseImageWakeLock();
      stopImageProgressTimer();
      if (state.imagePollTimer) {
        clearInterval(state.imagePollTimer);
        state.imagePollTimer = null;
      }
      if (timeoutId) clearTimeout(timeoutId);
      if (job.status === 'generating') job.status = 'done';
      if (activeReply?.status === 'generating') activeReply.status = 'done';
      persist();
      imageDbPutJob(job);
      updateSidebar();
      renderImageWorkspace();
      scrollImageWorkspaceToBottom(false);
      updateImageGenerateBtn();
    }

    try {
      const swTarget = await ensureServiceWorkerTarget();
      if (swTarget) {
        // === SW background mode: Service Worker owns the long image request ===
        const stopSwImage = (status = 'stopped') => {
          try { swTarget.postMessage({ type: 'stop-image', status, ownerId: state.appClientId }); } catch { /* ignore */ }
        };
        state.imageAbortController = { abort: () => {
          stopSwImage();
        }};
        const swData = ImageApi.buildServiceWorkerRequest({
          imageEndpoint: effectiveImageEndpoint(),
          mapEndpoint: imageMapEndpoint(),
          model: state.imageModel,
          mapModel: state.imageMapModel,
          prompt,
          params,
          refs,
          jobId: job.id,
          startedAt,
          timeoutMs: requestTimeoutMs,
        });
        swData.ownerId = state.appClientId;

        const handleImageSession = async session => {
          if (!session || (session.jobId && session.jobId !== job.id)) return false;
          if (session.status === 'streaming') {
            if (applyStreamingImageSession(job, activeReply, session)) {
              persist();
              imageDbPutJob(job);
              updateSidebar();
              scheduleImageWorkspaceRender({ scroll: true });
              updateImageGenerateBtn();
            }
            return false;
          }
          if (session.status === 'complete') {
            completeImageJobFromSession(job, activeReply, session, startedAt);
            applyImageProgressFromSession(job, activeReply, session);
            if (refs.length) { setImageReferences([]); renderImageRefPreview(); }
            const totalCount = Math.max(1, Number(session.totalCount) || Number(activeReply?.params?.count) || 1);
            const outputCount = (activeReply.outputs || []).filter(isRenderableImageOutput).length;
            showToast(job.status === 'done'
              ? (outputCount < totalCount ? `已生成 ${outputCount}/${totalCount} 张，部分请求失败` : '图片已生成')
              : '生成失败');
            finishImageJob();
            await clearImageSession();
            return true;
          }
          if (session.status === 'error') {
            failImageJob(session.error || '生成失败');
            showToast('生成失败');
            finishImageJob();
            await clearImageSession();
            return true;
          }
          if (session.status === 'timeout') {
            failImageJob(session.error || '生成超时，请稍后重试。');
            showToast('生成超时');
            finishImageJob();
            await clearImageSession();
            return true;
          }
          if (session.status === 'stopped') {
            failImageJob('请求已中断', 'cancelled');
            showToast('生成已中断');
            finishImageJob();
            await clearImageSession();
            return true;
          }
          return false;
        };
        const onImageSessionMessage = event => {
          if (event.data?.type !== 'image-session') return;
          handleImageSession(normalizeImageSession(event.data.session)).then(done => {
            if (done) removeImageSessionMessage();
          });
        };
        navigator.serviceWorker.addEventListener('message', onImageSessionMessage);
        const removeImageSessionMessage = () => {
          try { navigator.serviceWorker.removeEventListener('message', onImageSessionMessage); } catch { /* ignore */ }
        };
        swTarget.postMessage(swData);

        // Poll IndexedDB for image result (every 500ms)
        state.imagePollTimer = setInterval(async () => {
          const session = await getImageSession();
          const sessionStartedAt = session?.startedAt || startedAt;
          const sessionTimeoutMs = Math.max(requestTimeoutMs, Number(session?.timeoutMs) || 0);
          const timedOut = Date.now() - sessionStartedAt > sessionTimeoutMs;
          if (!session) {
            if (timedOut) {
              stopSwImage('timeout');
              failImageJob('生成超时，请稍后重试。');
              showToast('生成超时');
              finishImageJob();
            }
            return;
          }
          if (session.jobId && session.jobId !== job.id) return;

          if (await handleImageSession(session)) {
            removeImageSessionMessage();
          } else if (timedOut || Date.now() - (session.updatedAt || sessionStartedAt) > imageStaleTimeoutMs()) {
            stopSwImage('timeout');
            failImageJob('生成超时，请稍后重试。');
            showToast('生成超时');
            finishImageJob();
            removeImageSessionMessage();
            await clearImageSession();
          }
        }, 500);

      } else {
        // === Fallback: no SW, direct fetch; multi-image mode uses a small queue of n=1 requests ===
        timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
        const requestSingleImage = () => state.imageMapModel
          ? ImageApi.requestMappedImage(imageMapEndpoint(), prompt, params, refs, controller.signal)
          : refs.length
            ? ImageApi.requestImageEdit(effectiveImageEndpoint(), state.imageModel, prompt, params, refs, controller.signal)
            : ImageApi.requestOneImage(effectiveImageEndpoint(), state.imageModel, prompt, params, controller.signal);
        const maxParallel = Math.max(1, Math.min(requestCount, 5));
        const outputs = [];
        const usages = [];
        let directCompleted = 0;
        let directFailed = 0;
        const currentOutputs = () => outputs.filter(Boolean).slice(0, requestCount);
        const failedOutput = (error, requestIndex) => ({
          failed: true,
          requestIndex,
          error: String(error?.message || error || '生成失败'),
          createdAt: Date.now(),
        });
        const updateDirectProgress = () => {
          const nextOutputs = currentOutputs();
          const successCount = nextOutputs.filter(isRenderableImageOutput).length;
          const progress = {
            total: requestCount,
            completed: Math.min(requestCount, directCompleted),
            success: successCount,
            failed: directFailed,
            maxParallel,
          };
          activeReply.progress = progress;
          job.progress = progress;
          activeReply.outputs = nextOutputs;
          activeReply.usage = ImageCore.combineImageUsages(usages);
          job.outputs = activeReply.outputs;
          job.usage = activeReply.usage;
          persist();
          imageDbPutJob(job);
          updateSidebar();
          scheduleImageWorkspaceRender({ scroll: true });
          updateImageGenerateBtn();
        };
        const runQueue = async worker => {
          const settled = new Array(requestCount);
          let nextIndex = 0;
          let active = 0;
          return new Promise(resolve => {
            const launch = () => {
              if (nextIndex >= requestCount && active === 0) {
                resolve(settled);
                return;
              }
              while (active < maxParallel && nextIndex < requestCount && !controller.signal.aborted) {
                const index = nextIndex++;
                active += 1;
                Promise.resolve()
                  .then(() => worker(index))
                  .then(value => {
                    settled[index] = { status: 'fulfilled', value };
                  }, reason => {
                    settled[index] = { status: 'rejected', reason };
                  })
                  .finally(() => {
                    active -= 1;
                    launch();
                  });
              }
              if (controller.signal.aborted && active === 0) resolve(settled);
            };
            launch();
          });
        };
        const settled = await runQueue(async requestIndex => {
          try {
            const result = await requestSingleImage();
            const resultOutputs = ImageCore.imageResultOutputs(result).map(out => Object.assign({}, out, { requestIndex }));
            if (!resultOutputs.length) throw new Error('接口未返回可显示的图片数据');
            outputs[requestIndex] = resultOutputs[0];
            const usage = ImageCore.imageResultUsage(result);
            if (usage) usages.push(usage);
            directCompleted += 1;
            updateDirectProgress();
            return result;
          } catch (error) {
            outputs[requestIndex] = failedOutput(error, requestIndex);
            directCompleted += 1;
            directFailed += 1;
            updateDirectProgress();
            throw error;
          }
        });
        if (controller.signal.aborted) {
          const abortError = new Error('Aborted');
          abortError.name = 'AbortError';
          throw abortError;
        }
        const finalOutputs = currentOutputs();
        const successOutputs = finalOutputs.filter(isRenderableImageOutput);
        if (successOutputs.length === 0) {
          const firstError = settled.find(item => item?.status === 'rejected')?.reason;
          activeReply.outputs = finalOutputs;
          job.outputs = activeReply.outputs;
          setImageJobFailed(job, activeReply, String(firstError?.message || firstError || '生成失败'), 'error', startedAt);
        } else {
          setImageJobDone(job, activeReply, finalOutputs, startedAt, ImageCore.combineImageUsages(usages));
        }
        activeReply.progress = {
          total: requestCount,
          completed: requestCount,
          success: successOutputs.length,
          failed: directFailed,
          maxParallel,
        };
        job.progress = activeReply.progress;
        if (refs.length) { setImageReferences([]); renderImageRefPreview(); }
        showToast(successOutputs.length >= requestCount ? '图片已生成' : `已生成 ${successOutputs.length}/${requestCount} 张，部分请求失败`);
        finishImageJob();
      }
    } catch (e) {
      const aborted = e?.name === 'AbortError';
      failImageJob(
        aborted ? '请求已中断。可能是手动取消、页面刷新或等待超时，请重试。' : `${e.message}${e.diagnostics ? `\n\n${e.diagnostics}` : ''}`,
        aborted ? 'cancelled' : 'error',
      );
      showToast(aborted ? '生成已中断' : '生成失败');
      finishImageJob();
    }
  }

  // ===== Event Binding =====
  // Sidebar
  dom.sidebarToggle.addEventListener('click', toggleSidebar);
  dom.sidebarBackdrop.addEventListener('click', closeSidebarMobile);
  dom.sidebarBulkToggle.addEventListener('click', () => {
    state.sidebarBulkMode = true;
    state.sidebarSelectedIds.clear();
    updateSidebar();
  });
  dom.sidebarBulkSelectAll.addEventListener('click', () => {
    const selected = state.sidebarVisibleIds.filter(id => state.sidebarSelectedIds.has(id)).length;
    if (state.sidebarVisibleIds.length > 0 && selected === state.sidebarVisibleIds.length) {
      state.sidebarVisibleIds.forEach(id => state.sidebarSelectedIds.delete(id));
    } else {
      state.sidebarVisibleIds.forEach(id => state.sidebarSelectedIds.add(id));
    }
    updateSidebar();
  });
  dom.sidebarBulkDelete.addEventListener('click', deleteSelectedSidebarItems);
  dom.sidebarBulkCancel.addEventListener('click', () => {
    resetSidebarBulkMode();
    updateSidebar();
  });
  let searchTimer;
  dom.sidebarSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.sidebarSearch = dom.sidebarSearch.value;
      updateSidebar();
    }, 300);
  });
  dom.modeChatBtn.addEventListener('click', () => {
    switchMode('chat');
  });
  dom.modeImageBtn.addEventListener('click', () => switchMode('image'));
  dom.newChatBtn.addEventListener('click', () => {
    if (isImageModeLike()) {
      state.currentImageJobId = null;
      state.imageCanvasMode = false;
      dom.imagePrompt.value = '';
      setImageReferences([]);
      renderImageRefPreview();
      syncImageParams();
      persist();
      updateSidebar();
      renderImageWorkspace();
      closeSidebarMobile();
      if (state.mode === 'image') dom.imagePrompt.focus();
      return;
    }
    pauseActivePolls();
    newConv();
    updateSidebar();
    closeSidebarMobile();
    syncConvParams();
    resumeStreamPollIfNeeded();
    dom.userInput.focus();
  });

  // Sync params to/from current conversation
  function syncConvParams() {
    const conv = currentConv();
    if (conv) {
      const hadModel = !!conv.model;
      ensureConversationModel(conv);
      if (!hadModel && conv.model) persist([KEYS.conversations]);
      dom.paramTemperature.value = conv.temperature;
      dom.paramTopP.value = conv.topP;
      dom.paramMaxTokens.value = tokensToK(explicitMaxTokens(conv), '');
      dom.paramContextLimit.value = tokensToK(conv.contextLimit, DEFAULT_CONTEXT_LIMIT);
      dom.convRenameInput.value = conv.title;
      dom.convRoleInput.value = conv.systemPrompt || '';
    }
    updateModelBadge();
    updateThinkingToggleBtn();
    updateContextToggleBtn();
  }

  function saveConvParams() {
    const conv = currentConv();
    if (!conv) return;
    conv.temperature = parseFloat(dom.paramTemperature.value) || 0.7;
    conv.topP = parseFloat(dom.paramTopP.value) || 1;
    conv.maxTokens = kToTokens(dom.paramMaxTokens.value, null);
    conv.contextLimit = kToTokens(dom.paramContextLimit.value, DEFAULT_CONTEXT_LIMIT, { allowZero: true });
    conv.systemPrompt = dom.convRoleInput.value.trim();
    const newName = dom.convRenameInput.value.trim();
    if (newName) conv.title = newName;
    persist();
    updateSidebar();
    updateConversationTokenSummary();
  }

  function toggleConvSettings() {
    dom.convSettingsPanel.classList.toggle('hidden');
    const open = !dom.convSettingsPanel.classList.contains('hidden');
    dom.convSettingsBtn.classList.toggle('active', open);
    if (open) {
      syncConvParams();
    }
  }

  function toggleImageSettings() {
    dom.imageSettingsPanel.classList.toggle('hidden');
    const open = !dom.imageSettingsPanel.classList.contains('hidden');
    dom.imageSettingsBtn.classList.toggle('active', open);
    if (open) syncImageParams();
  }

  dom.convSettingsBtn.addEventListener('click', toggleConvSettings);
  dom.thinkingToggleBtn.addEventListener('click', () => {
    const conv = currentConv();
    if (!conv) return;
    conv.showThinking = !conversationShowThinking(conv);
    const showThinking = conversationShowThinking(conv);
    persist([KEYS.conversations]);
    updateThinkingToggleBtn();
    if (state.isStreaming) {
      const streamingMsg = currentConv()?.messages.find(m => m.streaming);
      const streamingHasContent = !!(streamingMsg?.content || '').trim();
      if (showThinking) {
        dom.messages.querySelectorAll('.thinking-block.hidden').forEach(el => el.classList.remove('hidden'));
        const reasoning = streamingMsg?.reasoningContent || '';
        if (reasoning && state.streamEls?.thinkingBlock) {
          showThinkingContent(state.streamEls, reasoning, { resetUserToggle: true });
          if (streamingMsg?.reasoningTimeMs != null) {
            applyThinkingDoneLabel(state.streamEls, streamingMsg.reasoningTimeMs, reasoning);
          }
        }
      } else {
        dom.messages.querySelectorAll('.thinking-block').forEach(el => {
          el.classList.add('hidden');
          el.classList.remove('expanded');
          delete el.dataset.userToggled;
        });
        state.streamEls?.waiting?.classList.toggle('hidden', streamingHasContent);
      }
    } else if (showThinking) {
      renderMessages();
    } else {
      dom.messages.querySelectorAll('.thinking-block').forEach(el => {
        el.classList.add('hidden');
        el.classList.remove('expanded');
        delete el.dataset.userToggled;
      });
    }
    showToast(showThinking ? '已显示思考过程' : '已隐藏思考过程');
  });
  dom.contextToggleBtn.addEventListener('click', () => {
    const conv = currentConv();
    if (!conv) return;
    conv.includeContextDefault = !conversationIncludeContext(conv);
    const includeContext = conversationIncludeContext(conv);
    persist([KEYS.conversations]);
    updateContextToggleBtn();
    showToast(includeContext ? '发送时将携带上文' : '发送时不携带上文');
  });
  dom.imageSettingsBtn.addEventListener('click', toggleImageSettings);
  dom.paramTemperature.addEventListener('change', saveConvParams);
  dom.paramTopP.addEventListener('change', saveConvParams);
  dom.paramMaxTokens.addEventListener('change', saveConvParams);
  dom.paramContextLimit.addEventListener('change', saveConvParams);
  dom.convRenameInput.addEventListener('change', saveConvParams);
  dom.convRoleInput.addEventListener('change', saveConvParams);
  dom.convRoleInput.addEventListener('blur', saveConvParams);

  // Conversation list
  // Pause UI polls when switching away — generation continues in SW, polls restart on return
  function pauseActivePolls() {
    if (state.chatPollTimer) { clearInterval(state.chatPollTimer); state.chatPollTimer = null; }
    if (state.imagePollTimer) { clearInterval(state.imagePollTimer); state.imagePollTimer = null; }
    stopImageProgressTimer();
  }

  // Restart UI poll when switching back to a conversation that's actively streaming
  function resumeStreamPollIfNeeded() {
    const conv = currentConv();
    if (!conv) {
      state.isStreaming = false;
      state.streamingConvId = null;
      releaseChatWakeLock();
      updateInputState();
      return;
    }

    const streamIdx = conv.messages.findIndex(m => m.streaming);
    if (streamIdx < 0) {
      // Current conversation is not streaming
      state.isStreaming = false;
      state.streamingConvId = null;
      syncChatWakeLock();
      updateInputState();
      renderMessages();
      return;
    }

    // Current conv has a streaming placeholder — check if it matches the active stream
    // Render current state immediately so the user sees content right away
    renderMessages();

    if (navigator.serviceWorker?.controller) {
      // SW proxy mode: check if the active stream belongs to this conversation
      (async () => {
        const session = await getStreamSession();
        if (!session || (session.convId && session.convId !== conv.id)) {
          // No active SW session or session belongs to a different conv
          // Finalize the placeholder as stopped
          finalizeStreamingPlaceholder(conv, streamIdx, conv.messages[streamIdx].content || '', conv.messages[streamIdx].reasoningContent || '');
          return;
        }

        // Session matches this conversation
        state.isStreaming = true;
        state.streamingConvId = conv.id;
        requestChatWakeLock();
        updateSendBtn();

        if (session.status === 'complete' || session.status === 'error' || session.status === 'stopped') {
          // Stream already finished — finalize immediately
          finalizeStreamFromSession(conv, streamIdx, session);
          return;
        }

        // Stream is still active — start/resume the UI poll
        removeTyping();
        $('stream-el')?.remove();
        state.streamEls = addStreamMsg();
        const streamEls = state.streamEls;
        const streamProgress = StreamSessionPoller.createProgressState({
          lastContent: conv.messages[streamIdx].content || '',
        });

        // Show already-accumulated content
        const initialContent = session.assistantContent || '';
        const initialReasoning = session.reasoningContent || '';
        if (initialContent) {
          renderStreamContent(streamEls, initialContent);
          streamProgress.lastContent = initialContent;
        }
        if (conversationShowThinking(conv) && initialReasoning) {
          showThinkingContent(streamEls, initialReasoning);
          streamProgress.reasoningStartTime = Date.now() - 1000;
        }
        StreamUi.scrollToBottom(dom.messages);

        state.chatAbortController = { abort: () => {
          navigator.serviceWorker.controller.postMessage({ type: 'stop-stream', ownerId: state.appClientId });
        }};

        state.chatPollTimer = setInterval(async () => {
          const session = await getStreamSession();
          if (!session) return;

          const progress = StreamSessionPoller.applyProgress(streamProgress, session);
          const content = progress.content;
          const reasoning = progress.reasoning;
          if (conversationShowThinking(conv) && reasoning) streamEls.waiting?.classList.add('hidden');

          updateThinkingStream(streamEls, reasoning, streamProgress.reasoningStartTime, streamProgress.streamStartTime, conv);

          if (progress.contentChanged) {
            if (conversationShowThinking(conv)) streamEls.waiting?.classList.add('hidden');
            else streamEls.waiting?.classList.toggle('hidden', !!content.trim());
            renderStreamContent(streamEls, content, { hideWaiting: false });
          }

          if (conversationShowThinking(conv) && reasoning && content) {
            finishThinkingStream(streamEls, streamProgress.reasoningStartTime, streamProgress.streamStartTime, streamProgress.reasoningEndTime, reasoning);
          } else if (content && !reasoning) {
            hideEmptyThinkingStream(streamEls);
          }

          if (StreamSessionPoller.isTerminalSession(session)) {
            clearInterval(state.chatPollTimer);
            state.chatPollTimer = null;
            StreamSessionPoller.ensureSessionOutputTime(session, streamProgress);
            finalizeStreamFromSession(conv, streamIdx, session);
          }
        }, 100);
      })();
    } else {
      // Fallback mode: the async try/catch flow is still running in the background.
      // The closure holds references to conv and streamMsgIdx, so it will update conv.messages.
      // Replace the stale streamEls reference so the fallback flow updates the new DOM elements.
      state.isStreaming = true;
      state.streamingConvId = conv.id;
      requestChatWakeLock();
      updateSendBtn();
      removeTyping();
      $('stream-el')?.remove();
      state.streamEls = addStreamMsg();
      // The fallback flow's closure `streamEls` is stale — we update `state.streamEls` here,
      // but the closure still uses the old one. This is acceptable: DOM updates to removed
      // elements silently fail, and conv.messages is still being updated with partial content.
      // The new streamEls will be visible and show current content; updates will come via
      // periodic persist of conv.messages[streamMsgIdx] which we could poll if needed.
      const existingContent = conv.messages[streamIdx].content || '';
      const existingReasoning = conv.messages[streamIdx].reasoningContent || '';
      if (existingContent) {
        renderStreamContent(state.streamEls, existingContent);
      }
      if (conversationShowThinking(conv) && existingReasoning) {
        showThinkingContent(state.streamEls, existingReasoning);
      }
      StreamUi.scrollToBottom(dom.messages);

      // Start a poll for the fallback mode to update the recreated stream UI from conv.messages
      // (since the fallback flow's streamEls is stale and its DOM updates are lost)
      state.chatPollTimer = setInterval(() => {
        const placeholder = conv.messages[streamIdx];
        if (!placeholder?.streaming) {
          // Stream completed — the fallback flow finalized the message
          clearInterval(state.chatPollTimer);
          state.chatPollTimer = null;
          state.isStreaming = false;
          state.streamingConvId = null;
          releaseChatWakeLock();
          $('stream-el')?.remove();
          renderMessages();
          dom.userInput.focus();
          updateSendBtn();
          return;
        }
        const c = placeholder.content || '';
        const r = placeholder.reasoningContent || '';
        if (c) {
          renderStreamContent(state.streamEls, c);
        }
        if (conversationShowThinking(conv) && r) {
          showThinkingContent(state.streamEls, r);
        }
      }, 500);
    }
  }

  // Finalize a completed/failed/stopped stream session into a proper message
  function finalizeStreamFromSession(conv, streamIdx, session) {
    const content = session.assistantContent || '';
    const reasoning = session.reasoningContent || '';
    const usage = OwnChatStream.normalizeUsage(session.usage);
    const outputTokens = usageOutputTokens(usage, estimateTokens(content));
    const requestInputTokens = Number(session.requestInputTokens || conv.messages[streamIdx]?.requestInputTokens || 0);
    const chatModel = session.model || conversationModel(conv);
    let msgData;
    if (session.status === 'error') {
      const detail = session.error ? `\n\n\`\`\`text\n${session.error}\n\`\`\`` : '';
      msgData = { role: 'assistant', content: `**错误**: 请求失败${detail}`, tokens: 0, model: chatModel };
    } else if (session.status === 'stopped') {
      const stoppedContent = content.trim() ? `${content}\n\n_已停止生成_` : '**已停止生成**';
      msgData = { role: 'assistant', content: stoppedContent, tokens: outputTokens, model: chatModel };
      if (usage) msgData.usage = usage;
      if (reasoning) msgData.reasoningContent = reasoning;
    } else {
      msgData = { role: 'assistant', content, tokens: outputTokens, model: chatModel };
      if (usage) msgData.usage = usage;
      if (reasoning) { msgData.reasoningContent = reasoning; }
    }
    const outputTimeMs = session.outputTimeMs != null ? Number(session.outputTimeMs) : null;
    if (Number.isFinite(outputTimeMs)) msgData.outputTimeMs = outputTimeMs;

    if (conv.messages[streamIdx]?.streaming) conv.messages[streamIdx] = msgData;
    else conv.messages.push(msgData);

    if (conv.messages.filter(m => m.role === 'user').length === 1) {
      const firstUserMsg = conv.messages.find(m => m.role === 'user');
      const titleText = typeof firstUserMsg?.content === 'string' ? firstUserMsg.content : '';
      conv.title = titleText.slice(0, 30) + (titleText.length > 30 ? '...' : '');
    }

    state.isStreaming = false;
    state.streamingConvId = null;
    state.chatAbortController = null;
    releaseChatWakeLock();

    persist([KEYS.conversations, KEYS.currentConvId]);
    updateModelBadge();
    updateSidebar();

    $('stream-el')?.remove();
    renderMessages();
    dom.userInput.focus();
    updateSendBtn();
    clearStreamSession();
  }

  // Finalize a streaming placeholder as a stopped message (no active stream available)
  function finalizeStreamingPlaceholder(conv, streamIdx, content, reasoning) {
    const stoppedContent = content.trim() ? `${content}\n\n_已停止生成_` : '**已停止生成**';
    const msgData = { role: 'assistant', content: stoppedContent, tokens: estimateTokens(content), model: conv.messages[streamIdx]?.model || conversationModel(conv) };
    if (reasoning) msgData.reasoningContent = reasoning;
    if (conv.messages[streamIdx]?.streaming) conv.messages[streamIdx] = msgData;
    else conv.messages.push(msgData);

    if (conv.messages.filter(m => m.role === 'user').length === 1) {
      const firstUserMsg = conv.messages.find(m => m.role === 'user');
      const titleText = typeof firstUserMsg?.content === 'string' ? firstUserMsg.content : '';
      conv.title = titleText.slice(0, 30) + (titleText.length > 30 ? '...' : '');
    }

    state.isStreaming = false;
    state.streamingConvId = null;
    state.chatAbortController = null;
    releaseChatWakeLock();

    persist([KEYS.conversations, KEYS.currentConvId]);
    updateSidebar();
    renderMessages();
    updateSendBtn();
    updateInputState();
  }

  function updateInputState() {
    updateSendBtn();
    updateContextToggleBtn();
  }

  function startSidebarRename(item, currentTitle, onSave) {
    const titleEl = item.querySelector('.conv-item-title');
    titleEl.innerHTML = `<input class="conv-rename-input" type="text" value="${esc(currentTitle)}" maxlength="50">`;
    const input = titleEl.querySelector('.conv-rename-input');
    input.focus();
    input.select();

    const finishRename = () => {
      const newTitle = input.value.trim() || currentTitle;
      onSave(newTitle);
    };

    input.addEventListener('blur', finishRename, { once: true });
    input.addEventListener('keydown', (ke) => {
      if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
      if (ke.key === 'Escape') { input.value = currentTitle; input.blur(); }
    });
  }

  async function deleteSelectedSidebarItems() {
    const ids = state.sidebarVisibleIds.filter(id => state.sidebarSelectedIds.has(id));
    if (!ids.length) return;
    const typeLabel = isImageModeLike() ? '绘画记录' : '对话';
    if (!confirm(`确认删除选中的 ${ids.length} 条${typeLabel}？此操作不可恢复。`)) return;
    const idSet = new Set(ids);
    if (isImageModeLike()) {
      state.imageJobs = state.imageJobs.filter(j => !idSet.has(j.id));
      if (state.currentImageJobId && idSet.has(state.currentImageJobId)) {
        state.currentImageJobId = state.imageJobs[0]?.id || null;
      }
      resetSidebarBulkMode();
      persist();
      await Promise.all(ids.map(id => imageDbDeleteJob(id)));
      updateSidebar();
      syncImageParams();
      renderImageWorkspace();
      if (state.mode === 'image') scrollImageWorkspaceToBottom(false);
      updateStorageStatsIfOpen();
      return;
    }

    const deletedConvs = state.conversations.filter(c => idSet.has(c.id));
    state.conversations = state.conversations.filter(c => !idSet.has(c.id));
    if (state.currentConvId && idSet.has(state.currentConvId)) {
      state.currentConvId = state.conversations[0]?.id || null;
    }
    resetSidebarBulkMode();
    persist();
    await Promise.allSettled(collectDeletedOnlyFileIds(deletedConvs).map(fileDbDelete));
    updateSidebar();
    syncConvParams();
    renderMessages();
    updateStorageStatsIfOpen();
  }

  async function handleSidebarItemActivate(e) {
    const bulkCheck = e.target.closest('[data-action="bulk-check"]');
    if (bulkCheck) {
      return;
    }
    if (state.sidebarBulkMode && e.target.closest('.conv-item-check')) return;
    if (state.sidebarBulkMode && e.target.closest('.conv-item')) {
      const item = e.target.closest('.conv-item');
      const id = item.dataset.id;
      if (state.sidebarSelectedIds.has(id)) state.sidebarSelectedIds.delete(id);
      else state.sidebarSelectedIds.add(id);
      updateSidebar();
      return;
    }

    if (isImageModeLike()) {
      const renameBtn = e.target.closest('.conv-item-rename');
      if (renameBtn) {
        const item = renameBtn.closest('.conv-item');
        const id = item.dataset.id;
        const job = state.imageJobs.find(j => j.id === id);
        if (!job) return;
        const currentTitle = job.title || job.prompt || '未命名绘画';
        startSidebarRename(item, currentTitle, (newTitle) => {
          job.title = newTitle;
          persist();
          imageDbPutJob(job);
          updateSidebar();
          if (id === state.currentImageJobId) renderImageWorkspace();
        });
        return;
      }

      const delBtn = e.target.closest('.conv-item-delete');
      if (delBtn) {
        const item = delBtn.closest('.conv-item');
        const id = item.dataset.id;
        state.imageJobs = state.imageJobs.filter(j => j.id !== id);
        if (state.currentImageJobId === id) state.currentImageJobId = state.imageJobs[0]?.id || null;
        const nextJob = state.imageJobs.find(j => j.id === state.currentImageJobId);
        state.imageCanvasMode = isImageCanvasJob(nextJob) && canUseImageCanvas();
        persist();
        await imageDbDeleteJob(id);
        updateSidebar();
        syncImageParams();
        renderImageWorkspace();
        scrollImageWorkspaceToBottom(false);
        updateStorageStatsIfOpen();
        return;
      }
      const item = e.target.closest('.conv-item');
      if (item) {
        state.currentImageJobId = item.dataset.id;
        const selectedJob = state.imageJobs.find(j => j.id === state.currentImageJobId);
        if (isImageCanvasJob(selectedJob)) {
          if (!canUseImageCanvas()) {
            state.imageCanvasMode = false;
            showToast('移动端暂不支持无限画布');
          } else {
            state.imageCanvasMode = true;
          }
        } else {
          state.imageCanvasMode = false;
        }
        persist();
        updateSidebar();
        syncImageParams();
        renderImageWorkspace();
        if (!state.imageCanvasMode) scrollImageWorkspaceToBottom(false);
        closeSidebarMobile();
      }
      return;
    }

    const renameBtn = e.target.closest('.conv-item-rename');
    if (renameBtn) {
      const item = renameBtn.closest('.conv-item');
      const id = item.dataset.id;
      const conv = state.conversations.find(c => c.id === id);
      if (!conv) return;
      const currentTitle = conv.title;
      startSidebarRename(item, currentTitle, (newTitle) => {
        conv.title = newTitle;
        persist();
        updateSidebar();
        if (id === state.currentConvId) renderMessages();
      });
      return;
    }

    const delBtn = e.target.closest('.conv-item-delete');
    if (delBtn) {
      const item = delBtn.closest('.conv-item');
      const id = item.dataset.id;
      const deletedConv = state.conversations.find(c => c.id === id);
      state.conversations = state.conversations.filter(c => c.id !== id);
      if (state.currentConvId === id) {
        state.currentConvId = state.conversations[0]?.id || null;
      }
      persist();
      await Promise.allSettled(collectDeletedOnlyFileIds([deletedConv]).map(fileDbDelete));
      updateSidebar();
      syncConvParams();
      renderMessages();
      updateStorageStatsIfOpen();
      return;
    }

    const item = e.target.closest('.conv-item');
    if (item) {
      pauseActivePolls();
      state.currentConvId = item.dataset.id;
      persist();
      updateSidebar();
      syncConvParams();
      closeSidebarMobile();
      resumeStreamPollIfNeeded();
      renderMessages();
    }
  }

  let sidebarTouchStart = null;
  dom.convList.addEventListener('touchstart', (e) => {
    const item = e.target.closest('.conv-item');
    if (!item || e.target.closest('.conv-item-rename, .conv-item-delete, .conv-rename-input')) {
      sidebarTouchStart = null;
      return;
    }
    const touch = e.changedTouches?.[0];
    sidebarTouchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }, { passive: true });

  dom.convList.addEventListener('touchend', (e) => {
    const item = e.target.closest('.conv-item');
    if (!item || e.target.closest('.conv-item-rename, .conv-item-delete, .conv-rename-input, .conv-item-check')) return;
    const touch = e.changedTouches?.[0];
    if (touch && sidebarTouchStart) {
      const dx = Math.abs(touch.clientX - sidebarTouchStart.x);
      const dy = Math.abs(touch.clientY - sidebarTouchStart.y);
      sidebarTouchStart = null;
      if (dx > 10 || dy > 10) return;
    }
    e.preventDefault();
    handleSidebarItemActivate(e);
  }, { passive: false });

  dom.convList.addEventListener('change', (e) => {
    const bulkCheck = e.target.closest('[data-action="bulk-check"]');
    if (!bulkCheck) return;
    const id = bulkCheck.dataset.id;
    if (bulkCheck.checked) state.sidebarSelectedIds.add(id);
    else state.sidebarSelectedIds.delete(id);
    updateSidebarBulkBar();
  });

  dom.convList.addEventListener('click', handleSidebarItemActivate);

  // Settings
  dom.themeBtn.addEventListener('click', toggleTheme);
  dom.settingsBtn.addEventListener('click', () => showSettings());
  dom.modalClose.addEventListener('click', hideSettings);
  dom.cfgCancel.addEventListener('click', hideSettings);
  dom.settingsModal.querySelector('.modal-backdrop').addEventListener('click', hideSettings);
  dom.settingsChatTab.addEventListener('click', () => {
    switchSettingsTab('chat');
  });
  dom.settingsImageTab.addEventListener('click', () => {
    switchSettingsTab('image');
  });
  dom.cfgChatEndpointSelect.addEventListener('change', () => {
    try { captureEndpointForm('chat', { normalize: false }); } catch { /* keep switching responsive */ }
    selectEndpoint('chat', dom.cfgChatEndpointSelect.value);
    refreshEndpointForm('chat');
    populateImageMapModelSelect();
    populateImagePromptModelSelect();
  });
  dom.cfgImageEndpointSelect.addEventListener('change', () => {
    try { captureEndpointForm('image', { normalize: false, allowFallback: true }); } catch { /* keep switching responsive */ }
    selectEndpoint('image', dom.cfgImageEndpointSelect.value);
    refreshEndpointForm('image');
    populateImageMapModelSelect();
    populateImagePromptModelSelect();
    syncImageBackgroundSupport();
  });
  dom.cfgAddChatEndpoint.addEventListener('click', () => {
    try { captureEndpointForm('chat', { normalize: false }); } catch { /* ignore incomplete draft */ }
    createEndpoint('chat');
    refreshEndpointForm('chat');
    populateImageMapModelSelect();
    populateImagePromptModelSelect();
  });
  dom.cfgAddImageEndpoint.addEventListener('click', () => {
    try { captureEndpointForm('image', { normalize: false, allowFallback: true }); } catch { /* ignore incomplete draft */ }
    createEndpoint('image');
    refreshEndpointForm('image');
    populateImageMapModelSelect();
    populateImagePromptModelSelect();
    syncImageBackgroundSupport();
  });
  dom.cfgDeleteChatEndpoint.addEventListener('click', () => {
    if (!deleteCurrentEndpoint('chat')) return;
    refreshEndpointForm('chat');
    populateImageMapModelSelect();
    populateImagePromptModelSelect();
  });
  dom.cfgDeleteImageEndpoint.addEventListener('click', () => {
    if (!deleteCurrentEndpoint('image')) return;
    refreshEndpointForm('image');
    populateImageMapModelSelect();
    populateImagePromptModelSelect();
    syncImageBackgroundSupport();
  });
  [dom.cfgImageModelSelect, dom.cfgImageModelManual, dom.cfgImageMapModelSelect, dom.cfgImageMapModelManual].forEach(el => {
    el.addEventListener('change', syncImageBackgroundSupport);
    el.addEventListener('input', syncImageBackgroundSupport);
  });
  dom.clearChatStorage.addEventListener('click', clearChatStorage);
  dom.clearImageStorage.addEventListener('click', clearImageStorage);
  [dom.requestPersistentStorageChat, dom.requestPersistentStorageImage].filter(Boolean).forEach(btn => {
    btn.addEventListener('click', requestPersistentStorage);
  });

  document.querySelectorAll('[data-secret-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.secretToggle);
      if (!input) return;
      const visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      btn.classList.toggle('is-visible', !visible);
      btn.title = visible ? '显示密钥' : '隐藏密钥';
      btn.setAttribute('aria-label', btn.title);
    });
  });

  document.querySelectorAll('[data-secret-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const input = $(btn.dataset.secretCopy);
      const value = input?.value || '';
      if (!value) { showToast('没有可复制的密钥'); return; }
      try {
        await navigator.clipboard.writeText(value);
        showToast('密钥已复制');
      } catch {
        input.focus();
        input.select();
        document.execCommand('copy');
        input.setSelectionRange(input.value.length, input.value.length);
        showToast('密钥已复制');
      }
    });
  });

  dom.cfgRefreshModels.addEventListener('click', () => {
    try { captureEndpointForm('chat', { normalize: false }); } catch { /* refresh will validate below */ }
    refreshModelsForSelect(dom.cfgBaseUrl.value.trim(), dom.cfgApiKey.value.trim(), dom.cfgModelSelect, dom.cfgRefreshModels);
  });

  dom.cfgRefreshImageModels.addEventListener('click', async () => {
    try { captureEndpointForm('image', { normalize: false, allowFallback: true }); } catch { /* refresh will validate below */ }
    await refreshModelsForSelect(dom.cfgImageBaseUrl.value.trim(), dom.cfgImageApiKey.value.trim(), dom.cfgImageModelSelect, dom.cfgRefreshImageModels, { image: true });
    populateImageMapModelSelect();
    populateImagePromptModelSelect();
    dom.cfgImageMapModelSelect.value = parseMapModelRef(state.imageMapModel).value;
    dom.cfgImagePromptModelSelect.value = parsePromptModelRef(state.imagePromptModel).value;
  });

  dom.cfgExportConfig.addEventListener('click', () => {
    downloadJson(`ownchat-config-${Date.now()}.json`, appConfigSnapshot(true));
  });
  dom.cfgImportFile.addEventListener('click', () => dom.cfgImportInput.click());
  dom.cfgImportInput.addEventListener('change', () => {
    const file = dom.cfgImportInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        showConfigImportConfirm(ConfigImport.parse(String(reader.result || '')));
      } catch (e) {
        alert(`导入配置失败: ${e.message}`);
      }
    };
    reader.readAsText(file);
    dom.cfgImportInput.value = '';
  });

  dom.configImportClose.addEventListener('click', hideConfigImportConfirm);
  dom.configImportCancel.addEventListener('click', hideConfigImportConfirm);
  dom.configImportModal.querySelector('.modal-backdrop').addEventListener('click', hideConfigImportConfirm);
  dom.configImportApply.addEventListener('click', () => {
    if (!state.pendingImportConfig) return;
    try {
      applyImportedConfig(state.pendingImportConfig);
      hideConfigImportConfirm();
      hideSetup();
      state.settingsSnapshot = null;
      hideModal(dom.settingsModal);
      if (!currentConv()) newConv();
      updateSidebar();
      syncConvParams();
      showToast('接口配置已导入');
    } catch (e) {
      alert(`导入配置失败: ${e.message}`);
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.copy-menu')) closeCopyMenus();
  });
  document.addEventListener('keydown', handleModalKeydown);

  dom.cfgSave.addEventListener('click', () => {
    const savingImageTab = dom.settingsImageTab.classList.contains('active');
    const imm = dom.cfgImageMapModelManual.value.trim();
    const mapModel = parseMapModelRef(imm || dom.cfgImageMapModelSelect.value).value;
    const ipm = dom.cfgImagePromptModelManual.value.trim();
    const promptModel = parsePromptModelRef(ipm || dom.cfgImagePromptModelSelect.value).value;

    const needChat = !savingImageTab;
    const needImage = savingImageTab;

    try {
      const chatEndpoint = captureEndpointForm('chat', { requireComplete: needChat });
      const imageEndpoint = captureEndpointForm('image', { requireComplete: needImage, allowFallback: true });
      if (needChat && currentConv()) {
        currentConv().endpointId = chatEndpoint.id;
        currentConv().model = chatEndpoint.model;
      }
      state.conversations.forEach(conv => {
        if (conv.endpointId && !state.chatEndpoints.some(endpoint => endpoint.id === conv.endpointId)) {
          conv.endpointId = state.currentChatEndpointId;
        }
      });
      if (needImage || imageEndpoint.model) {
        state.imageMapModel = mapModel || '';
        state.imagePromptModel = promptModel || '';
        state.imageDefaults = sanitizeImageParams(state.imageDefaults);
      }
    } catch (e) {
      alert(e.message);
      return;
    }
    persist();
    updateModelBadge();
    syncImageParams();
    closeSettingsAfterSave();
    updateSendBtn();
    updateImageGenerateBtn();
  });

  // Setup overlay
  dom.setupRefreshModels.addEventListener('click', () => {
    refreshModelsForSelect(dom.setupBaseUrl.value.trim(), dom.setupApiKey.value.trim(), dom.setupModelSelect, dom.setupRefreshModels);
  });

  dom.setupSave.addEventListener('click', () => {
    const b = dom.setupBaseUrl.value.trim();
    const k = dom.setupApiKey.value.trim();
    const m = dom.setupModelSelect.value;
    if (!b || !k || !m) { alert('请填写所有配置项并选择模型'); return; }
    updateEndpoint('chat', {
      name: currentChatEndpoint().name || '默认对话接口',
      baseUrl: normalizeUrl(b),
      apiKey: k,
      model: m,
      models: mergeUnique([m], currentChatEndpoint().models),
    });
    if (currentConv()) {
      currentConv().endpointId = currentChatEndpoint().id;
      if (!currentConv().model) currentConv().model = m;
    }
    persist();
    updateModelBadge();
    hideSetup();
    newConv();
    updateSidebar();
    renderMessages();
    dom.userInput.focus();
  });
  dom.setupLater.addEventListener('click', () => {
    hideSetup();
    if (!currentConv()) { newConv(); updateSidebar(); syncConvParams(); renderMessages(); }
  });

  // Model dropdown in header
  dom.modelDropdownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (dom.modelDropdownList.classList.contains('hidden')) {
      openModelDropdown();
    } else {
      closeModelDropdown();
    }
  });

  dom.modelDropdownList.addEventListener('click', (e) => {
    e.stopPropagation();
    const opt = e.target.closest('.model-option');
    if (!opt) return;
    if (isImageModeLike()) {
      updateEndpoint('image', {
        model: opt.dataset.model,
        models: mergeUnique([opt.dataset.model], currentImageEndpoint().models, DEFAULT_IMAGE_MODELS),
      });
      state.imageDefaults = sanitizeImageParams(state.imageDefaults);
      persist([KEYS.imageModel, KEYS.imageEndpoints, KEYS.currentImageEndpointId, KEYS.imageModelsCache]);
      syncImageParams();
    }
    else {
      const conv = currentConv() || newConv();
      conv.model = opt.dataset.model;
      conv.endpointId = chatEndpointForConversation(conv)?.id || state.currentChatEndpointId;
      const endpoint = chatEndpointForConversation(conv);
      endpoint.model = conv.model;
      endpoint.models = mergeUnique([conv.model], endpoint.models);
      syncLegacyFromEndpoints();
      persist([KEYS.conversations, KEYS.currentConvId, KEYS.chatEndpoints, KEYS.currentChatEndpointId, KEYS.modelsCache, KEYS.model]);
    }
    updateModelBadge();
    closeModelDropdown();
    updateSendBtn();
    updateImageGenerateBtn();
    showToast(`已切换到 ${isImageModeLike() ? state.imageModel : conversationModel()}`);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.model-dropdown')) closeModelDropdown();
    if (!e.target.closest('#conv-settings-panel') && !e.target.closest('#conv-settings-btn')) {
      dom.convSettingsPanel.classList.add('hidden');
      dom.convSettingsBtn.classList.remove('active');
    }
    if (!e.target.closest('#image-settings-panel') && !e.target.closest('#image-settings-btn')) {
      dom.imageSettingsPanel.classList.add('hidden');
      dom.imageSettingsBtn.classList.remove('active');
    }
  });

  // Message action buttons & thinking toggle
  dom.messages.addEventListener('click', (e) => {
    const attachmentImage = e.target.closest('.msg-img[data-action="view-attachment-image"]');
    if (attachmentImage) {
      openAttachmentImageViewer(attachmentImage.src, attachmentImage.dataset.name || attachmentImage.alt || 'attachment');
      return;
    }

    const thinkingToggle = e.target.closest('.thinking-toggle');
    if (thinkingToggle) {
      closeCopyMenus();
      const block = thinkingToggle.closest('.thinking-block');
      block.dataset.userToggled = 'true';
      block.classList.toggle('expanded');
      return;
    }

    const codeCopyBtn = e.target.closest('.code-copy-btn');
    if (codeCopyBtn) {
      closeCopyMenus();
      const codeBlock = codeCopyBtn.closest('.code-block');
      const code = codeBlock.querySelector('code')?.textContent || '';
      copyText(code);
      codeCopyBtn.classList.add('copied');
      setTimeout(() => codeCopyBtn.classList.remove('copied'), 1500);
      return;
    }

    const btn = e.target.closest('.msg-action-btn, .copy-menu-popover button');
    if (!btn) return;
    const conv = currentConv();
    if (!conv) return;
    const idx = parseInt(btn.dataset.idx);
    const msg = conv.messages[idx];
    if (!msg) return;

    if (btn.dataset.action === 'copy-menu') {
      const menu = btn.closest('.copy-menu');
      const isOpen = menu?.classList.contains('open');
      closeCopyMenus();
      if (menu && !isOpen) menu.classList.add('open');
    } else if (btn.dataset.action === 'copy-md') {
      closeCopyMenus();
      copyText(copyableMessageText(msg));
    } else if (btn.dataset.action === 'copy-text') {
      closeCopyMenus();
      copyText(copyableMessagePlainText(msg));
    } else if (btn.dataset.action === 'retry') {
      closeCopyMenus();
      retryMessage(idx);
    } else if (btn.dataset.action === 'edit') {
      closeCopyMenus();
      const text = messageTextContent(msg);
      dom.userInput.value = text;
      dom.userInput.focus();
      autoResize();
    }
  });

  // File upload
  dom.attachBtn.addEventListener('click', () => { dom.fileInput.click(); });

  function pastedImageName(file, index = 0) {
    const rawExt = (file.type || 'image/png').split('/')[1] || 'png';
    const ext = rawExt === 'jpeg' ? 'jpg' : rawExt.replace(/[^a-z0-9.+-]/gi, '') || 'png';
    const suffix = index ? `-${index + 1}` : '';
    return `pasted-image-${Date.now()}${suffix}.${ext}`;
  }

  function clipboardImageFiles(event) {
    const data = event.clipboardData;
    if (!data) return [];
    const itemFiles = Array.from(data.items || [])
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (itemFiles.length) return itemFiles;
    return Array.from(data.files || []).filter(file => file.type.startsWith('image/'));
  }

  function addChatAttachmentFile(file, opts = {}) {
    const name = opts.name || file.name || pastedImageName(file, opts.index || 0);
    if (state.pendingFiles.find(f => f.name === name && f.size === file.size)) return false;
    const entry = Attachments.createPendingEntry(file, name);
    state.pendingFiles.push(entry);
    renderFilePreview();
    updateSendBtn();

    Attachments.readIntoEntry(entry, file).finally(() => {
      renderFilePreview();
      updateSendBtn();
    });
    return true;
  }

  function addChatAttachmentFiles(files, opts = {}) {
    let added = 0;
    Array.from(files || []).forEach((file, index) => {
      const name = opts.pasted ? pastedImageName(file, index) : file.name;
      if (addChatAttachmentFile(file, { name, index })) added += 1;
    });
    return added;
  }

  function setImageReferenceFile(file, opts = {}) {
    if (!file || !file.type.startsWith('image/')) return false;
    if (!state.imageCanvasMode && imageReferenceList().length >= MAX_IMAGE_REFS) return false;
    const name = opts.name || file.name || pastedImageName(file, opts.index || 0);
    const reader = new FileReader();
    reader.onload = ev => {
      if (state.imageCanvasMode) {
        addImageCanvasReferenceNode({ name, type: file.type, base64: ev.target.result });
        showToast('参考图已添加到画布');
        return;
      }
      setImageReferences([...imageReferenceList(), { name, type: file.type, base64: ev.target.result }]);
      renderImageRefPreview();
      updateImageGenerateBtn();
    };
    reader.onerror = () => showToast('参考图读取失败');
    reader.readAsDataURL(file);
    return true;
  }

  function addImageReferenceFiles(files, opts = {}) {
    let added = 0;
    Array.from(files || []).some((file, index) => {
      if (!state.imageCanvasMode && imageReferenceList().length >= MAX_IMAGE_REFS) return true;
      const name = opts.pasted ? (file.name || pastedImageName(file, index)) : file.name;
      if (setImageReferenceFile(file, { name, index })) added += 1;
      return !state.imageCanvasMode && imageReferenceList().length >= MAX_IMAGE_REFS;
    });
    return added;
  }

  dom.fileInput.addEventListener('change', () => {
    addChatAttachmentFiles(dom.fileInput.files);
    dom.fileInput.value = '';
  });

  function renderFilePreview() {
    if (state.pendingFiles.length === 0) {
      dom.filePreview.classList.add('hidden');
      dom.filePreview.innerHTML = '';
      return;
    }
    dom.filePreview.classList.remove('hidden');
    dom.filePreview.innerHTML = state.pendingFiles.map((f, i) => {
      const inner = f.loading
        ? `<div class="file-icon file-loading"><span></span></div>`
        : f.base64
        ? `<img src="${f.base64}" class="file-thumb" data-action="preview-attachment-image" data-index="${i}" alt="${esc(f.name)}">`
        : `<div class="file-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>`;
      const readyStatus = f.extractionLabel ? esc(f.extractionLabel) : '';
      const status = f.error ? `<span class="file-status">${esc(f.errorText || '失败')}</span>` : (f.loading ? '<span class="file-status">读取中</span>' : (readyStatus ? `<span class="file-status">${readyStatus}</span>` : ''));
      const title = f.errorText ? `${f.name}: ${f.errorText}` : f.name;
      return `<div class="file-preview-item ${f.loading ? 'is-loading' : ''} ${f.error ? 'is-error' : ''}" data-index="${i}" title="${esc(title)}">${inner}<span class="file-name">${esc(f.name)}</span>${status}<button class="file-remove" data-index="${i}" type="button">&times;</button></div>`;
    }).join('');
  }

  dom.filePreview.addEventListener('click', (e) => {
    const img = e.target.closest('[data-action="preview-attachment-image"]');
    if (img) {
      const file = state.pendingFiles[parseInt(img.dataset.index, 10)];
      if (file?.base64) openAttachmentImageViewer(file.base64, file.name);
      return;
    }
    const btn = e.target.closest('.file-remove');
    if (!btn) return;
    const idx = parseInt(btn.dataset.index);
    state.pendingFiles.splice(idx, 1);
    renderFilePreview();
    updateSendBtn();
  });

  dom.imagePrompt.addEventListener('input', updateImageGenerateBtn);
  dom.userInput.addEventListener('paste', (e) => {
    const files = clipboardImageFiles(e);
    if (!files.length) return;
    e.preventDefault();
    const added = addChatAttachmentFiles(files, { pasted: true });
    if (added) showToast(added > 1 ? `已添加 ${added} 张粘贴图片` : '已添加粘贴图片');
  });
  dom.imagePrompt.addEventListener('paste', (e) => {
    const files = clipboardImageFiles(e);
    if (!files.length) return;
    e.preventDefault();
    const added = addImageReferenceFiles(files, { pasted: true });
    if (added) showToast(`已添加 ${added} 张参考图`);
    else showToast(`最多添加 ${MAX_IMAGE_REFS} 张参考图`);
  });
  dom.imageRefBtn.addEventListener('click', () => dom.imageRefInput.click());
  dom.imageOptimizeBtn.addEventListener('click', optimizeImagePrompt);
  dom.imageCanvasToggleBtn?.addEventListener('click', () => {
    if (!canUseImageCanvas()) {
      showToast('移动端暂不支持无限画布');
      return;
    }
    setImageCanvasMode(true);
  });
  dom.imageRefInput.addEventListener('change', () => {
    const added = addImageReferenceFiles(dom.imageRefInput.files);
    if (!added && dom.imageRefInput.files?.length) showToast(`最多添加 ${MAX_IMAGE_REFS} 张参考图`);
    dom.imageRefInput.value = '';
  });
  dom.imageRefPreview.addEventListener('click', (e) => {
    const btn = e.target.closest('.image-ref-remove');
    if (!btn) return;
    const card = btn.closest('.image-ref-card');
    const index = parseInt(card?.dataset.index || '-1', 10);
    const refs = imageReferenceList();
    if (index >= 0) refs.splice(index, 1);
    setImageReferences(refs);
    renderImageRefPreview();
    updateImageGenerateBtn();
  });
  [dom.imageSize, dom.imageQuality, dom.imageCount, dom.imageFormat, dom.imageBackground].forEach(el => {
    el.addEventListener('change', () => {
      saveImageParams();
      updateImageGenerateBtn();
    });
  });
  dom.imageGenerateBtn.addEventListener('click', () => {
    const params = saveImageParams();
    const prompt = dom.imagePrompt.value.trim();
    if (!ensureModeConfigured('image')) return;
    if (state.imageCanvasMode) {
      const canvas = currentImageCanvas();
      if (canvas?.planStatus === 'review') {
        showToast('请先确认任务拆解，或点击开始执行');
        return;
      }
      const selected = selectedCanvasNodes(canvas).filter(node => node.output && isRenderableImageOutput(node.output));
      const operation = !canvas || !canvas.nodes.length ? 'root' : selected.length >= 2 ? 'merge' : 'branch';
      if (!prompt && operation === 'root') return;
      generateImageCanvasNode(prompt, params, { operation, sources: selected });
      dom.imagePrompt.value = '';
      updateImageGenerateBtn();
      return;
    }
    if (!prompt) return;
    generateImage(prompt, params, currentImageJob());
    dom.imagePrompt.value = '';
    updateImageGenerateBtn();
  });
  dom.imagePrompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      dom.imageGenerateBtn.click();
    }
  });
  dom.imageCanvasWorkspace?.addEventListener('click', (e) => {
    const action = e.target.closest('.image-canvas-action');
    if (!action) return;
    e.preventDefault();
    handleImageCanvasAction(action.dataset.action, action);
  });
  dom.imageCanvasWorkspace?.addEventListener('input', handleImageCanvasTaskInput);
  dom.imageCanvasWorkspace?.addEventListener('keydown', handleImageCanvasInputKeydown);
  dom.imageCanvasWorkspace?.addEventListener('pointerdown', handleImageCanvasPointerDown);
  dom.imageCanvasWorkspace?.addEventListener('wheel', handleImageCanvasWheel, { passive: false });
  document.addEventListener('keydown', handleImageCanvasKeydown);
  document.addEventListener('pointermove', handleImageCanvasPointerMove);
  document.addEventListener('pointerup', handleImageCanvasPointerUp);
  document.addEventListener('pointercancel', handleImageCanvasPointerUp);
  dom.imageGallery.addEventListener('click', (e) => {
    const inputPreview = e.target.closest('.image-input-preview');
    if (inputPreview) {
      const job = state.imageJobs.find(j => j.id === inputPreview.dataset.job);
      const replyIndex = parseInt(inputPreview.dataset.reply || '', 10);
      const reply = Number.isFinite(replyIndex) ? imageJobReplies(job)[replyIndex] : null;
      const refIndex = parseInt(inputPreview.dataset.ref || '0', 10);
      const inputImage = imageReferencePayload(reply?.inputImages || job?.inputImages)[refIndex];
      if (inputImage) {
        openImageViewer(job, {
          inputRef: true,
          inputImage,
          refIndex,
          b64: inputImage.base64.split(',').pop(),
          format: (inputImage.type || '').replace(/^image\//, '') || (reply?.params || job.params)?.outputFormat || 'png',
        }, Number.isFinite(replyIndex) ? replyIndex : 0);
      }
      return;
    }

    const preview = e.target.closest('.image-preview');
    if (preview) {
      const result = preview.closest('.image-result');
      const job = state.imageJobs.find(j => j.id === result.dataset.job);
      const replyIndex = parseInt(result.dataset.reply || '0', 10);
      const { out } = imageReplyOutput(job, replyIndex, parseInt(result.dataset.index, 10));
      if (job && out) openImageViewer(job, out, replyIndex);
      return;
    }

    const btn = e.target.closest('.image-action');
    if (!btn) return;
    const job = state.imageJobs.find(j => j.id === btn.dataset.job);
    if (!job) return;
    if (btn.dataset.action === 'reuse') {
      dom.imagePrompt.value = btn.dataset.prompt || job.prompt;
      state.currentImageJobId = job.id;
      job.params = sanitizeImageParams(Object.assign({}, DEFAULT_IMAGE_PARAMS, job.params || {}, {
        size: btn.dataset.size || job.params?.size || DEFAULT_IMAGE_PARAMS.size,
        quality: btn.dataset.quality || job.params?.quality || DEFAULT_IMAGE_PARAMS.quality,
        count: btn.dataset.count || job.params?.count || DEFAULT_IMAGE_PARAMS.count,
        outputFormat: btn.dataset.format || job.params?.outputFormat || DEFAULT_IMAGE_PARAMS.outputFormat,
        background: btn.dataset.background || job.params?.background || DEFAULT_IMAGE_PARAMS.background,
      }));
      imageDbPutJob(job);
      syncImageParams();
      updateImageGenerateBtn();
      persist();
      updateSidebar();
      dom.imagePrompt.focus();
    } else if (btn.dataset.action === 'copy-prompt') {
      copyText(btn.dataset.prompt || job.prompt || '');
    } else if (btn.dataset.action === 'retry') {
      if (job.status === 'generating') return;
      const replyIndex = parseInt(btn.dataset.reply || '0', 10);
      const reply = imageJobReplies(job)[Number.isFinite(replyIndex) ? replyIndex : 0] || null;
      const retryPrompt = reply?.prompt || job.prompt || '';
      const retryParams = Object.assign({}, DEFAULT_IMAGE_PARAMS, job.params || {}, reply?.params || {});
      const retryRef = reply?.inputImages || job.inputImages || null;
      state.currentImageJobId = job.id;
      generateImage(retryPrompt, retryParams, job, retryRef);
    } else if (btn.dataset.action === 'retry-failed-image') {
      const replyIndex = parseInt(btn.dataset.reply || '0', 10);
      const outputIndex = parseInt(btn.dataset.index || '0', 10);
      state.currentImageJobId = job.id;
      retryFailedImageInPlace(job, replyIndex, outputIndex);
    } else if (btn.dataset.action === 'cancel') {
      cancelImageGeneration();
    } else if (btn.dataset.action === 'view') {
      const replyIndex = parseInt(btn.dataset.reply || '0', 10);
      const { out } = imageReplyOutput(job, replyIndex, parseInt(btn.dataset.index, 10));
      if (out) openImageViewer(job, out, replyIndex);
    } else if (btn.dataset.action === 'edit-latest') {
      const replyIndex = parseInt(btn.dataset.reply || '0', 10);
      const { reply, out } = imageReplyOutput(job, replyIndex, 0);
      if (!out) {
        showToast('暂无可编辑的图片');
        return;
      }
      if (!out.b64) {
        showToast('链接图片无法直接作为参考图，请先下载后上传');
        return;
      }
      setImageReferences([{
        name: imageFilename(job, out),
        type: `image/${out.format || reply?.params?.outputFormat || job.params?.outputFormat || 'png'}`,
        base64: dataUrlForImage(out, (reply?.params || job.params)?.outputFormat),
      }]);
      dom.imagePrompt.value = '基于参考图进行编辑：';
      state.currentImageJobId = job.id;
      renderImageRefPreview();
      updateImageGenerateBtn();
      persist();
      updateSidebar();
      renderImageWorkspace();
      dom.imagePrompt.focus();
    } else if (btn.dataset.action === 'use-as-ref') {
      const replyIndex = parseInt(btn.dataset.reply || '0', 10);
      const { reply, out } = imageReplyOutput(job, replyIndex, parseInt(btn.dataset.index, 10));
      if (!out) return;
      if (!out.b64) {
        showToast('链接图片无法直接作为参考图，请先下载后上传');
        return;
      }
      setImageReferences([{
        name: imageFilename(job, out),
        type: `image/${out.format || reply?.params?.outputFormat || job.params?.outputFormat || 'png'}`,
        base64: dataUrlForImage(out, (reply?.params || job.params)?.outputFormat),
      }]);
      dom.imagePrompt.value = '基于参考图进行编辑：';
      state.currentImageJobId = job.id;
      renderImageRefPreview();
      updateImageGenerateBtn();
      persist();
      updateSidebar();
      renderImageWorkspace();
      dom.imagePrompt.focus();
    } else if (btn.dataset.action === 'copy-image') {
      const replyIndex = parseInt(btn.dataset.reply || '0', 10);
      const { out } = imageReplyOutput(job, replyIndex, parseInt(btn.dataset.index, 10));
      if (out) copyImage(job, out);
    } else if (btn.dataset.action === 'download') {
      const replyIndex = parseInt(btn.dataset.reply || '0', 10);
      const { out } = imageReplyOutput(job, replyIndex, parseInt(btn.dataset.index, 10));
      if (!out) return;
      downloadImage(job, out);
    }
  });
  dom.imageGallery.addEventListener('load', (e) => {
    const img = e.target.closest?.('.image-preview');
    if (!img) return;
    const shouldKeepBottom = isImageWorkspaceNearBottom();
    const result = img.closest('.image-result');
    if (!result) return;
    updateImageOutputMeta(result.dataset.job, parseInt(result.dataset.index, 10), img);
    if (state.mode === 'image' && shouldKeepBottom) scrollImageWorkspaceToBottom(false);
  }, true);

  ImageViewer.mount({
    viewer: dom.imageViewer,
    backdrop: dom.imageViewer.querySelector('.image-viewer-backdrop'),
    img: dom.imageViewerImg,
    closeBtn: dom.imageViewerClose,
    prevBtn: dom.imageViewerPrev,
    nextBtn: dom.imageViewerNext,
    counter: dom.imageViewerCounter,
    zoomOutBtn: dom.imageViewerZoomOut,
    zoomResetBtn: dom.imageViewerZoomReset,
    zoomInBtn: dom.imageViewerZoomIn,
    copyBtn: dom.imageViewerCopy,
    downloadBtn: dom.imageViewerDownload,
  }, {
    onCopy() {
      const current = currentViewerImage();
      if (!current) return;
      if (current.attachment) copyAttachmentImage(current);
      else copyImage(current.job, current.out);
    },
    onDownload() {
      const current = currentViewerImage();
      if (!current) return;
      if (current.attachment) downloadAttachmentImage(current);
      else downloadImage(current.job, current.out);
    },
  });

  window.addEventListener('beforeunload', (e) => {
    // Check if ANY conversation is streaming in background
    const hasStreamingConv = state.streamingConvId && state.conversations.find(c => c.id === state.streamingConvId && c.messages.some(m => m.streaming));
    if (hasStreamingConv || state.isGeneratingImage) {
      // In SW mode: SW is handling persistence, just warn the user
      // In fallback mode: persist partial content for crash recovery
      if (hasStreamingConv && !navigator.serviceWorker?.controller) {
        const conv = state.conversations.find(c => c.id === state.streamingConvId);
        if (conv) {
          const streamMsg = conv.messages.find(m => m.streaming);
          if (streamMsg) persist([KEYS.conversations]);
        }
      }
      e.preventDefault();
      e.returnValue = hasStreamingConv ? '回复正在生成，刷新页面可通过 Service Worker 继续接收。' : '图片正在生成，刷新或关闭页面会中断当前请求。';
    }
  });
  document.addEventListener('visibilitychange', syncWakeLocks);

  // Send
  dom.sendBtn.addEventListener('click', () => {
    // If any conversation is streaming in the background, abort it before starting a new one
    if (state.isStreaming || state.streamingConvId) {
      state.chatAbortController?.abort();
      // If we were streaming a DIFFERENT conversation, also clean up its placeholder
      if (state.streamingConvId && state.streamingConvId !== currentConv()?.id) {
        const oldConv = state.conversations.find(c => c.id === state.streamingConvId);
        if (oldConv) {
          const streamIdx = oldConv.messages.findIndex(m => m.streaming);
          if (streamIdx >= 0) {
            const content = oldConv.messages[streamIdx].content || '';
            const reasoning = oldConv.messages[streamIdx].reasoningContent || '';
            // In SW mode: the abort sends stop-stream, SW will finalize in IndexedDB.
            // We directly finalize the placeholder here since we know it was stopped.
            oldConv.messages[streamIdx] = { role: 'assistant', content: content.trim() ? `${content}\n\n_已停止生成_` : '**已停止生成**', tokens: estimateTokens(content), model: oldConv.messages[streamIdx].model || conversationModel(oldConv) };
            if (reasoning) oldConv.messages[streamIdx].reasoningContent = reasoning;
            persist([KEYS.conversations]);
            updateSidebar();
            clearStreamSession();
          }
        }
        state.isStreaming = false;
        state.streamingConvId = null;
        state.chatAbortController = null;
        releaseChatWakeLock();
      }
      if (state.isStreaming) return; // was streaming current conv — just stop it, user needs to click again to send
      // If we aborted a background stream, allow sending in current conv
    }
    const text = dom.userInput.value.trim();
    if (!ensureModeConfigured('chat')) return;
    if (state.pendingFiles.some(Attachments.isLoading)) {
      showToast('附件还在读取中，请稍后发送');
      updateSendBtn();
      return;
    }
    if (state.pendingFiles.some(Attachments.hasError)) {
      showToast('请先移除失败附件后再发送');
      updateSendBtn();
      return;
    }
    if (!text && !state.pendingFiles.some(Attachments.isReady)) return;
    if (!currentConv()) { newConv(); updateSidebar(); syncConvParams(); }
    dom.userInput.value = '';
    delete dom.userInput.dataset.manualHeight;
    autoResize();
    sendMsg(text);
  });

  dom.userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (state.isStreaming) return;
      dom.sendBtn.click();
    }
  });

  dom.userInput.addEventListener('input', () => {
    autoResize();
    updateSendBtn();
  });

  // ===== Init =====
  applyTheme();
  dom.settingsModal.setAttribute('aria-hidden', 'true');
  dom.configImportModal.setAttribute('aria-hidden', 'true');
  updateModeA11y();
  setupTextareaResizeHandles();

  // Register Service Worker for long requests and refresh recovery.
  registerServiceWorker();

  // Recover streaming messages: check SW session first (better data), then local flags
  async function recoverStreamFromSession() {
    const session = await getStreamSession();
    if (!session) return false;

    const conv = state.conversations.find(c => c.id === session.convId);
    if (!conv) {
      await clearStreamSession();
      return false;
    }

    // Find or create the streaming placeholder in messages
    let streamIdx = conv.messages.findIndex(m => m.streaming);

    if (session.status === 'complete') {
      // Stream finished while page was refreshing — full recovery
      const usage = OwnChatStream.normalizeUsage(session.usage);
      const msgData = {
        role: 'assistant',
        content: session.assistantContent || '',
        tokens: usageOutputTokens(usage, estimateTokens(session.assistantContent)),
        model: session.model,
      };
      if (usage) msgData.usage = usage;
      if (session.reasoningContent) msgData.reasoningContent = session.reasoningContent;

      if (streamIdx >= 0) {
        conv.messages[streamIdx] = msgData;
      } else {
        conv.messages.push(msgData);
      }
      persist([KEYS.conversations]);
      await clearStreamSession();
      return true;
    }

    // SW is still streaming or connecting — start live recovery
    if (session.status === 'streaming' || session.status === 'connecting') {
      state.isStreaming = true;
      state.streamingConvId = conv.id;
      requestChatWakeLock();
      const usage = OwnChatStream.normalizeUsage(session.usage);
      const msgData = {
        role: 'assistant',
        content: session.assistantContent || '...',
        tokens: usageOutputTokens(usage, estimateTokens(session.assistantContent)),
        model: session.model,
        streaming: true,
      };
      if (usage) msgData.usage = usage;
      if (session.reasoningContent) msgData.reasoningContent = session.reasoningContent;

      if (streamIdx >= 0) {
        conv.messages[streamIdx] = msgData;
      } else {
        conv.messages.push(msgData);
      }
      persist([KEYS.conversations]);
      startStreamRecoveryPolling(conv);
      return true;
    }

    // SW reported stopped (user aborted before page refresh)
    if (session.status === 'stopped') {
      const content = (session.assistantContent || '').trim();
      const usage = OwnChatStream.normalizeUsage(session.usage);
      const stoppedContent = content ? `${content}\n\n_已停止生成_` : '**已停止生成**';
      const msgData = { role: 'assistant', content: stoppedContent, tokens: usageOutputTokens(usage, estimateTokens(content)), model: session.model };
      if (usage) msgData.usage = usage;
      if (session.reasoningContent) msgData.reasoningContent = session.reasoningContent;
      if (streamIdx >= 0) conv.messages[streamIdx] = msgData;
      else conv.messages.push(msgData);
      persist([KEYS.conversations]);
      await clearStreamSession();
      return true;
    }

    // SW reported error
    if (session.status === 'error') {
      const content = (session.assistantContent || '').trim();
      if (content) {
        const usage = OwnChatStream.normalizeUsage(session.usage);
        const msgData = {
          role: 'assistant',
          content: `${content}\n\n_（回复中断）_`,
          tokens: usageOutputTokens(usage, estimateTokens(content)),
          model: session.model,
        };
        if (usage) msgData.usage = usage;
        if (session.reasoningContent) msgData.reasoningContent = session.reasoningContent;
        if (streamIdx >= 0) {
          conv.messages[streamIdx] = msgData;
        } else {
          conv.messages.push(msgData);
        }
      } else if (streamIdx >= 0) {
        conv.messages.splice(streamIdx, 1);
      }
      persist([KEYS.conversations]);
      await clearStreamSession();
      return true;
    }

    return false;
  }

  // Live polling: update message content from SW's IndexedDB every 500ms
  let streamRecoveryTimer = null;

  function startStreamRecoveryPolling(conv) {
    if (streamRecoveryTimer) return;

    // Create the stream UI element once (like addStreamMsg)
    let recoveryEls = null;
    function createRecoveryUI(msg) {
      const el = document.createElement('div');
      el.className = 'chat-msg ai';
      el.id = 'recovery-el';
      const showThinking = conversationShowThinking(conv);
      const hasReasoning = showThinking && !!msg.reasoningContent;
      el.innerHTML = `
        <div class="chat-msg-inner">
          <div class="chat-msg-avatar">${Icons.aiAvatar}</div>
          <div class="chat-msg-body">
            <div class="stream-waiting ${hasReasoning ? 'hidden' : ''}">
              <div class="typing-dots"><span></span><span></span><span></span></div>
            </div>
            ${showThinking ? `<div class="thinking-block ${hasReasoning ? 'expanded' : 'hidden'}">
              <button class="thinking-toggle" type="button">
                <svg class="thinking-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                <span class="thinking-label">${hasReasoning ? '正在恢复思考过程...' : ''}</span>
              </button>
              <div class="thinking-content"><div class="msg-md"></div></div>
            </div>` : ''}
            <div class="msg-md"></div>
            <div class="msg-meta"><span class="msg-meta-item">正在恢复回复...</span></div>
          </div>
        </div>
      `;
      dom.messages.appendChild(el);
      StreamUi.scrollToBottom(dom.messages);
      return {
        contentMd: el.querySelector('.chat-msg-body > .msg-md'),
        thinkingMd: el.querySelector('.thinking-content .msg-md'),
        thinkingLabel: el.querySelector('.thinking-label'),
        thinkingBlock: el.querySelector('.thinking-block'),
        waiting: el.querySelector('.stream-waiting'),
        metaRow: el.querySelector('.msg-meta'),
      };
    }

    streamRecoveryTimer = setInterval(async () => {
      const session = await getStreamSession();
      if (!session) {
        clearInterval(streamRecoveryTimer);
        streamRecoveryTimer = null;
        state.isStreaming = false;
        state.streamingConvId = null;
        releaseChatWakeLock();
        $('recovery-el')?.remove();
        renderMessages();
        return;
      }

      const streamIdx = conv.messages.findIndex(m => m.streaming);
      if (streamIdx < 0) {
        clearInterval(streamRecoveryTimer);
        streamRecoveryTimer = null;
        state.isStreaming = false;
        state.streamingConvId = null;
        releaseChatWakeLock();
        $('recovery-el')?.remove();
        renderMessages();
        return;
      }

      const msg = conv.messages[streamIdx];
      const usage = OwnChatStream.normalizeUsage(session.usage);
      msg.content = session.assistantContent || msg.content;
      if (session.reasoningContent) msg.reasoningContent = session.reasoningContent;
      msg.tokens = usageOutputTokens(usage, estimateTokens(msg.content));
      if (usage) msg.usage = usage;
      updateConversationTokenSummary();

      if (session.status === 'complete') {
        msg.streaming = false;
        delete msg.streaming;
        persist([KEYS.conversations]);
        await clearStreamSession();
        clearInterval(streamRecoveryTimer);
        streamRecoveryTimer = null;
        state.isStreaming = false;
        state.streamingConvId = null;
        releaseChatWakeLock();
        $('recovery-el')?.remove();
        renderMessages();
        showToast('回复已恢复完成');
        return;
      }

      if (session.status === 'stopped') {
        const content = (msg.content || '').trim();
        msg.content = content ? `${content}\n\n_已停止生成_` : '**已停止生成**';
        msg.streaming = false;
        delete msg.streaming;
        persist([KEYS.conversations]);
        await clearStreamSession();
        clearInterval(streamRecoveryTimer);
        streamRecoveryTimer = null;
        state.isStreaming = false;
        state.streamingConvId = null;
        releaseChatWakeLock();
        $('recovery-el')?.remove();
        renderMessages();
        return;
      }

      // Timeout: SW was killed (no update for 60s) or error
      if (session.status === 'error' || Date.now() - session.updatedAt > 60000) {
        const content = (msg.content || '').trim();
        if (content) {
          msg.content = `${content}\n\n_（回复中断，保存的部分内容）_`;
        } else {
          conv.messages.splice(streamIdx, 1);
        }
        msg.streaming = false;
        delete msg.streaming;
        persist([KEYS.conversations]);
        await clearStreamSession();
        clearInterval(streamRecoveryTimer);
        streamRecoveryTimer = null;
        state.isStreaming = false;
        state.streamingConvId = null;
        releaseChatWakeLock();
        $('recovery-el')?.remove();
        renderMessages();
        return;
      }

      // Incremental update: only update the recovery element's content, no full DOM rebuild
      if (!recoveryEls && session.status !== 'connecting') {
        // Remove the static rendered streaming message and replace with recovery UI
        const msgEls = dom.messages.querySelectorAll('.chat-msg.ai');
        const lastEl = msgEls[msgEls.length - 1];
        if (lastEl) lastEl.remove();
        recoveryEls = createRecoveryUI(msg);
      }

      // Skip UI update while SW is still connecting
      if (session.status === 'connecting' || !recoveryEls) return;

      if (conversationShowThinking(conv) && msg.reasoningContent && recoveryEls.thinkingMd) {
        const shouldFollow = StreamUi.isNearBottom(dom.messages);
        scheduleStreamRender(() => {
          recoveryEls.waiting?.classList.add('hidden');
          recoveryEls.thinkingMd.innerHTML = renderMd(msg.reasoningContent);
          recoveryEls.thinkingLabel.textContent = msg.content?.trim() ? '思考过程' : '正在恢复思考过程...';
          if (msg.content?.trim()) recoveryEls.thinkingBlock?.classList.remove('expanded');
          recoveryEls.contentMd.innerHTML = renderMd(msg.content);
          StreamUi.maybeScrollToBottom(dom.messages, shouldFollow);
        });
      } else {
        const shouldFollow = StreamUi.isNearBottom(dom.messages);
        scheduleStreamRender(() => {
          if (conversationShowThinking(conv)) {
            recoveryEls.waiting?.classList.add('hidden');
            if ((msg.content || '').trim()) hideEmptyThinkingStream(recoveryEls);
          } else {
            recoveryEls.waiting?.classList.toggle('hidden', !!(msg.content || '').trim());
          }
          recoveryEls.contentMd.innerHTML = renderMd(msg.content);
          StreamUi.maybeScrollToBottom(dom.messages, shouldFollow);
        });
      }
    }, 500);
  }

  // Also recover any local streaming flags (fallback if SW didn't catch it)
  function recoverInterruptedStreams() {
    let recovered = false;
    for (const conv of state.conversations) {
      for (let i = conv.messages.length - 1; i >= 0; i--) {
        const msg = conv.messages[i];
        if (msg?.streaming) {
          const content = (msg.content || '').trim();
          if (content) {
            msg.content = `${content}\n\n_（回复中断，页面刷新时保存的部分内容）_`;
            msg.streaming = false;
          } else {
            conv.messages.splice(i, 1);
          }
          recovered = true;
        }
      }
    }
    if (recovered) persist([KEYS.conversations]);
  }

  function applyRecoveredImageSession(job, session) {
    const activeReply = currentImageActiveReply(job);
    if (!activeReply) return;
    if (session.status === 'complete') {
      completeImageJobFromSession(job, activeReply, session);
      applyImageProgressFromSession(job, activeReply, session);
    } else if (session.status === 'stopped') {
      setImageJobFailed(job, activeReply, '请求已中断', 'cancelled');
    } else if (session.status === 'error') {
      setImageJobFailed(job, activeReply, session.error || '生成失败');
    } else if (session.status === 'timeout') {
      setImageJobFailed(job, activeReply, '生成超时');
    }
  }

  function applyImageProgressFromSession(job, activeReply, session) {
    const total = Math.max(1, Number(session?.totalCount) || Number(activeReply?.params?.count) || Number(job?.params?.count) || 1);
    const sessionOutputs = parseImageSessionOutputs(session);
    const outputSuccessCount = sessionOutputs.filter(isRenderableImageOutput).length;
    const success = Math.max(0, Number(session?.successCount) || outputSuccessCount || 0);
    const failed = Math.max(0, Number(session?.failedCount) || 0);
    const completed = Math.max(success + failed, Number(session?.completedCount) || 0);
    const progress = {
      total,
      completed: Math.min(total, completed),
      success,
      failed,
      maxParallel: Math.max(1, Number(session?.maxParallel) || 1),
    };
    activeReply.progress = progress;
    job.progress = progress;
    return progress;
  }

  function applyStreamingImageSession(job, activeReply, session) {
    const nextOutputs = parseImageSessionOutputs(session);
    const progress = applyImageProgressFromSession(job, activeReply, session);
    const currentLength = Array.isArray(activeReply.outputs) ? activeReply.outputs.length : 0;
    if (nextOutputs.length >= currentLength) activeReply.outputs = nextOutputs;
    activeReply.usage = ImageCore.normalizeImageUsage(session?.usage);
    activeReply.status = 'generating';
    if (nextOutputs.length >= currentLength) job.outputs = nextOutputs;
    job.usage = activeReply.usage;
    job.status = 'generating';
    job.error = null;
    return nextOutputs.length > currentLength || progress.completed > 0;
  }

  // Recover image generation session from Service Worker
  async function recoverImageFromSession() {
    const session = await getImageSession();
    if (!session) return false;

    const job = state.imageJobs.find(j => j.id === session.jobId);
    if (!job) {
      // Job was deleted, discard SW data
      await clearImageSession();
      return false;
    }

    if (session.status === 'complete') {
      applyRecoveredImageSession(job, session);
      persist();
      imageDbPutJob(job);
      updateSidebar();
      renderImageWorkspace();
      scrollImageWorkspaceToBottom(false);
      updateImageGenerateBtn();
      showToast(job.status === 'done' ? '图片已恢复完成' : '图片生成失败');
      await clearImageSession();
      return true;
    }

    if (session.status === 'stopped') {
      applyRecoveredImageSession(job, session);
      persist();
      imageDbPutJob(job);
      updateSidebar();
      renderImageWorkspace();
      scrollImageWorkspaceToBottom(false);
      updateImageGenerateBtn();
      await clearImageSession();
      return true;
    }

    if (session.status === 'error') {
      applyRecoveredImageSession(job, session);
      persist();
      imageDbPutJob(job);
      updateSidebar();
      renderImageWorkspace();
      scrollImageWorkspaceToBottom(false);
      updateImageGenerateBtn();
      await clearImageSession();
      return true;
    }

    if (session.status === 'timeout') {
      applyRecoveredImageSession(job, session);
      persist();
      imageDbPutJob(job);
      updateSidebar();
      renderImageWorkspace();
      scrollImageWorkspaceToBottom(false);
      updateImageGenerateBtn();
      await clearImageSession();
      return true;
    }

    // Still streaming/connecting — start polling (same pattern as chat recovery)
    if (session.status === 'streaming' || session.status === 'connecting') {
      job.status = 'generating';
      const activeReply = currentImageActiveReply(job);
      if (activeReply) {
        activeReply.status = 'generating';
        applyStreamingImageSession(job, activeReply, session);
      }
      const recoveredStartedAt = session.startedAt || activeReply?.startedAt || job.startedAt || job.createdAt || Date.now();
      const recoveredTimeoutMs = Math.max(
        Number(session.timeoutMs) || 0,
        imageTimeoutMs(activeReply?.params || job.params || state.imageDefaults),
      );
      const stopRecoveredSwImage = async () => {
        try {
          const target = await ensureServiceWorkerTarget(1000);
          target?.postMessage({ type: 'stop-image', status: 'timeout', ownerId: state.appClientId });
        } catch { /* ignore */ }
      };
      state.isGeneratingImage = true;
      state.currentImageJobId = job.id;
      requestImageWakeLock();
      startImageProgressTimer();
      persist();
      imageDbPutJob(job);
      updateSidebar();
      renderImageWorkspace();
      scrollImageWorkspaceToBottom(false);
      updateImageGenerateBtn();
      state.imagePollTimer = setInterval(async () => {
        const s = await getImageSession();
        if (!s) {
          clearInterval(state.imagePollTimer);
          state.imagePollTimer = null;
          state.isGeneratingImage = false;
          releaseImageWakeLock();
          stopImageProgressTimer();
          updateImageGenerateBtn();
          return;
        }

        const sStartedAt = s.startedAt || recoveredStartedAt;
        const sTimeoutMs = Math.max(recoveredTimeoutMs, Number(s.timeoutMs) || 0);
        if (s.status === 'streaming') {
          const latestReply = currentImageActiveReply(job);
          if (latestReply && applyStreamingImageSession(job, latestReply, s)) {
            persist(); imageDbPutJob(job);
            updateSidebar(); scheduleImageWorkspaceRender({ scroll: true }); updateImageGenerateBtn();
          }
        }
        if (s.status === 'complete') {
          clearInterval(state.imagePollTimer);
          state.imagePollTimer = null;
          state.isGeneratingImage = false;
          releaseImageWakeLock();
          stopImageProgressTimer();
          applyRecoveredImageSession(job, s);
          persist(); imageDbPutJob(job);
          updateSidebar(); renderImageWorkspace(); updateImageGenerateBtn();
          showToast(job.status === 'done' ? '图片已恢复完成' : '图片生成失败');
          await clearImageSession();
        } else if (s.status === 'error' || s.status === 'stopped' || s.status === 'timeout') {
          clearInterval(state.imagePollTimer);
          state.imagePollTimer = null;
          state.isGeneratingImage = false;
          releaseImageWakeLock();
          stopImageProgressTimer();
          applyRecoveredImageSession(job, s);
          persist(); imageDbPutJob(job);
          updateSidebar(); renderImageWorkspace(); updateImageGenerateBtn();
          await clearImageSession();
        } else if (Date.now() - sStartedAt > sTimeoutMs || Date.now() - (s.updatedAt || sStartedAt) > imageStaleTimeoutMs()) {
          clearInterval(state.imagePollTimer);
          state.imagePollTimer = null;
          state.isGeneratingImage = false;
          releaseImageWakeLock();
          stopImageProgressTimer();
          await stopRecoveredSwImage();
          applyRecoveredImageSession(job, Object.assign({}, s, { status: 'timeout' }));
          persist(); imageDbPutJob(job);
          updateSidebar(); renderImageWorkspace(); updateImageGenerateBtn();
          await clearImageSession();
        }

        // Keep elapsed time updated without rebuilding the whole image thread.
        updateImageProgressElapsed();
      }, 1000);
      return true;
    }

    return false;
  }

  // On mobile, start with sidebar collapsed
  if (isMobile()) {
    state.sidebarCollapsed = true;
    dom.sidebar.classList.add('collapsed');
    dom.sidebarBackdrop.classList.add('hidden');
    state.imageCanvasMode = false;
  } else {
    dom.sidebar.classList.toggle('collapsed', state.sidebarCollapsed);
  }
  window.addEventListener('resize', () => {
    if (isMobile() && state.imageCanvasMode) {
      state.imageCanvasMode = false;
      persist([KEYS.imageCanvasMode]);
      renderImageWorkspace();
      updateImageGenerateBtn();
    }
  });
  document.documentElement.removeAttribute('data-boot-sidebar');
  if (isImageModeLike()) state.isImageHistoryLoading = true;
  updateModelBadge();
  updateSidebar();
  updateSendBtn();
  updateThinkingToggleBtn();
  updateContextToggleBtn();
  syncImageParams();
  updateImageGenerateBtn();
  importConfigFromUrl();

  const imageHistoryReady = loadImageHistory();

  // Hydrate file attachments and recover sessions (async)
  hydrateFilesInConversations(state.conversations).then(async () => {
    await imageHistoryReady;
    // Recover chat stream and image generation sessions
    Promise.all([recoverStreamFromSession(), recoverImageFromSession()]).then(([swRecovered]) => {
      if (!swRecovered) recoverInterruptedStreams();

      if (configured() || imageConfigured()) {
        hideSetup();
        if (currentConv()) {
          renderMessages();
          syncConvParams();
        } else {
          newConv();
          updateSidebar();
          syncConvParams();
          dom.welcome.classList.remove('hidden');
          dom.messages.innerHTML = '';
        }
        switchMode(isImageModeLike(state.mode) ? state.mode : 'chat');
      } else {
        state.mode = 'chat';
        switchMode('chat');
        hideSetup();
        if (!currentConv()) { newConv(); updateSidebar(); syncConvParams(); renderMessages(); }
      }
    });
  });
})();
