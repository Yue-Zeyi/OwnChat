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

// ===== Storage =====
(function () {
  'use strict';

  const KEYS = {
    baseUrl: 'nc_base_url',
    apiKey: 'nc_api_key',
    model: 'nc_model',
    modelsCache: 'nc_models_cache',
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
    currentImageJobId: 'nc_current_image_job_id',
    imageDefaults: 'nc_image_defaults',
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
      if (Array.isArray(raw)) return raw;
      if (typeof raw !== 'string' || !raw.trim()) return [];
      const outputs = JSON.parse(raw);
      return Array.isArray(outputs) ? outputs : [];
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
    return {
      chatBaseUrl: stringValue(chat.baseUrl, chat.base_url, cfg.baseUrl, cfg.base_url),
      chatApiKey: stringValue(chat.apiKey, chat.api_key, cfg.apiKey, cfg.api_key),
      chatModel: stringValue(chat.model, cfg.model),
      imageBaseUrl: stringValue(image.baseUrl, image.base_url, cfg.imageBaseUrl, cfg.image_base_url),
      imageApiKey: stringValue(image.apiKey, image.api_key, cfg.imageApiKey, cfg.image_api_key),
      imageModel: stringValue(image.model, cfg.imageModel, cfg.image_model),
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
    if (nextOutputs.length === 0) {
      setImageJobFailed(job, activeReply, '接口未返回可显示的图片数据', 'error', startedAt);
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
    const base = { type: 'start-image', jobId, startedAt, timeoutMs, outputFormat: effectiveParams.outputFormat, count: effectiveParams.count || 1 };

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

    const outputList = reply.outputs || [];
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
    return `<div class="image-progress${opts.inline ? ' image-progress-inline' : ''}" data-job="${esc(job.id)}">
      <div class="image-progress-indicator">
        <div class="image-spinner"></div>
      </div>
      <div class="image-progress-body">
        <div class="image-progress-title">正在生成${count > 1 ? ` ${count} 张` : ''}图片</div>
        <div class="image-progress-stats">
          <span class="image-progress-elapsed">耗时 ${ImageCore.formatDuration(waitedMs)}</span>
          <span>完成 ${progress.completed}/${progress.total}</span>
          <span>成功 ${progress.success}</span>
          ${progress.failed ? `<span class="image-progress-failed">失败 ${progress.failed}</span>` : ''}
        </div>
        <div class="image-progress-note">${count > 1 ? '多张图片并发生成中，请勿关闭页面' : '正在生成，请勿关闭页面'}</div>
      </div>
      <button class="btn-secondary image-action image-cancel-btn" data-action="cancel" data-job="${esc(job.id)}" type="button">取消</button>
    </div>`;
  }

  function imageProgressInfo(job, reply = null) {
    const activeReply = reply || ImageCore.currentImageActiveReply(job) || {};
    const progress = activeReply.progress || job.progress || {};
    const total = Math.max(1, Number(progress.total) || Number(activeReply.params?.count) || Number(job.params?.count) || 1);
    const outputCount = (activeReply.outputs || []).length;
    const success = Math.max(0, Number.isFinite(Number(progress.success)) ? Number(progress.success) : outputCount);
    const failed = Math.max(0, Number(progress.failed) || 0);
    const completed = Math.min(total, Math.max(success + failed, Number(progress.completed) || 0));
    return { total, completed, success, failed };
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

    dom.closeBtn?.addEventListener('click', close);
    dom.backdrop?.addEventListener('click', close);
    dom.prevBtn?.addEventListener('click', () => switchImage(-1));
    dom.nextBtn?.addEventListener('click', () => switchImage(1));
    dom.img?.addEventListener('wheel', zoom, { passive: false });
    dom.img?.addEventListener('pointerdown', startDrag);
    dom.viewer?.addEventListener('pointermove', moveDrag);
    dom.viewer?.addEventListener('pointerup', endDrag);
    dom.viewer?.addEventListener('pointercancel', endDrag);
    dom.img?.addEventListener('dblclick', resetTransform);
    dom.img?.addEventListener('touchstart', startTouch, { passive: false });
    dom.img?.addEventListener('touchmove', moveTouch, { passive: false });
    dom.img?.addEventListener('touchend', endTouch);
    dom.img?.addEventListener('touchcancel', endTouch);
    dom.copyBtn?.addEventListener('click', () => callbacks.onCopy?.(current()));
    dom.downloadBtn?.addEventListener('click', () => callbacks.onDownload?.(current()));
    document.addEventListener('keydown', handleKeydown);
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
    dom.viewer.classList.add('hidden');
    dom.img.src = '';
    viewer = null;
    dragging = null;
    touch = null;
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
    dragging = null;
    applyTransform();
  }

  function zoom(e) {
    if (!isOpen()) return;
    e.preventDefault();
    const nextScale = clampScale(transform.scale * (e.deltaY < 0 ? 1.16 : 1 / 1.16));
    if (Math.abs(nextScale - transform.scale) < 0.001) return;

    const rect = dom.img.getBoundingClientRect();
    const cx = e.clientX - (rect.left + rect.width / 2);
    const cy = e.clientY - (rect.top + rect.height / 2);
    const ratio = nextScale / transform.scale;
    transform = {
      scale: nextScale,
      x: transform.x - cx * (ratio - 1),
      y: transform.y - cy * (ratio - 1),
    };
    applyTransform();
  }

  function startDrag(e) {
    if (!isOpen()) return;
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
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

  function renderSidebarItem({ id, title, active, bulkMode, selectedIds }) {
    return `
      <div class="conv-item ${active ? 'active' : ''} ${bulkMode ? 'bulk-mode' : ''}" data-id="${esc(id)}">
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
      listHtml: filtered.map(job => renderSidebarItem({
        id: job.id,
        title: imageJobTitle(job),
        active: job.id === currentId,
        bulkMode,
        selectedIds,
      })).join('') || '<div class="sidebar-empty">没有匹配的绘画</div>',
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

  const state = {
    appClientId: (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    mode: load(KEYS.mode) || 'chat',
    baseUrl: load(KEYS.baseUrl) || '',
    apiKey: load(KEYS.apiKey) || '',
    model: load(KEYS.model) || '',
    modelsCache: load(KEYS.modelsCache) || [],
    conversations: load(KEYS.conversations) || [],
    currentConvId: load(KEYS.currentConvId) || null,
    sidebarCollapsed: load(KEYS.sidebarCollapsed) || false,
    theme: load(KEYS.theme) || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
    imageBaseUrl: load(KEYS.imageBaseUrl) || '',
    imageApiKey: load(KEYS.imageApiKey) || '',
    imageModel: load(KEYS.imageModel) || 'gpt-image-2',
    imageMapModel: load(KEYS.imageMapModel) || '',
    imagePromptModel: load(KEYS.imagePromptModel) || '',
    imageModelsCache: load(KEYS.imageModelsCache) || DEFAULT_IMAGE_MODELS,
    imageJobs: [],
    currentImageJobId: load(KEYS.currentImageJobId) || null,
    imageDefaults: Object.assign({}, DEFAULT_IMAGE_PARAMS, load(KEYS.imageDefaults) || {}),
    isStreaming: false,
    streamingConvId: null,
    chatAbortController: null,
    chatPollTimer: null,
    chatWakeLock: null,
    streamEls: null,
    isGeneratingImage: false,
    imageAbortController: null,
    imageProgressTimer: null,
    imagePollTimer: null,
    imageWakeLock: null,
    isImageHistoryLoading: false,
    isOptimizingImagePrompt: false,
    textareaResize: null,
    imageRefs: [],
    pendingFiles: [],
    sidebarSearch: '',
    sidebarBulkMode: false,
    sidebarSelectedIds: new Set(),
    sidebarVisibleIds: [],
    pendingImportConfig: null,
  };

  function persist(keys) {
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
    if (summary.chatBaseUrl) state.baseUrl = normalizeUrl(summary.chatBaseUrl);
    if (summary.chatApiKey) state.apiKey = summary.chatApiKey;
    if (summary.chatModel) state.model = summary.chatModel;
    if (summary.imageBaseUrl) state.imageBaseUrl = normalizeUrl(summary.imageBaseUrl);
    if (summary.imageApiKey) state.imageApiKey = summary.imageApiKey;
    if (summary.imageModel) state.imageModel = summary.imageModel;
    if (summary.hasImageMapModel) state.imageMapModel = summary.imageMapModel;
    if (summary.hasImagePromptModel) state.imagePromptModel = summary.imagePromptModel;
    if (summary.imageDefaults) state.imageDefaults = Object.assign({}, DEFAULT_IMAGE_PARAMS, summary.imageDefaults);
    state.modelsCache = mergeUnique([state.model], summary.chatModels, state.modelsCache);
    if (summary.chatModel && currentConv() && !currentConv().model) currentConv().model = summary.chatModel;
    state.imageModelsCache = mergeUnique(
      [state.imageModel],
      summary.imageModels,
      state.imageModelsCache,
      DEFAULT_IMAGE_MODELS,
    );
    state.imageDefaults = sanitizeImageParams(state.imageDefaults);
    if (['image', 'draw', 'painting'].includes(summary.mode)) state.mode = 'image';
    if (['chat', 'dialog', 'conversation'].includes(summary.mode)) state.mode = 'chat';
    persist();
    updateModelBadge();
    updateSendBtn();
    updateImageGenerateBtn();
    switchMode(state.mode === 'image' ? 'image' : 'chat');
  }

  function showConfigImportConfirm(cfg) {
    state.pendingImportConfig = cfg;
    const summary = ConfigImport.summary(cfg);
    dom.configImportPreview.innerHTML = [
      ['模式', summary.mode || '不修改'],
      ['对话 Base URL', summary.chatBaseUrl || '不修改'],
      ['对话 API Key', ConfigImport.maskKey(summary.chatApiKey)],
      ['对话模型', summary.chatModel || '不修改'],
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

  function conversationModel(conv = currentConv()) {
    return conv?.model || state.model || '';
  }

  function ensureConversationModel(conv = currentConv()) {
    if (conv && !conv.model && state.model) conv.model = state.model;
    return conversationModel(conv);
  }

  function conversationShowThinking(conv = currentConv()) {
    return conv?.showThinking !== false;
  }

  function conversationIncludeContext(conv = currentConv()) {
    return conv?.includeContextDefault !== undefined ? conv.includeContextDefault !== false : true;
  }

  function newConv() {
    const conv = { id: Date.now().toString(), title: '新对话', messages: [], createdAt: Date.now(), model: state.model, temperature: 0.7, topP: 1, maxTokens: null, contextLimit: DEFAULT_CONTEXT_LIMIT, systemPrompt: '', showThinking: true, includeContextDefault: true };
    state.conversations.unshift(conv);
    state.currentConvId = conv.id;
    persist();
    return conv;
  }

  function effectiveImageBaseUrl() {
    return (state.imageBaseUrl || state.baseUrl || '').trim();
  }

  function effectiveImageApiKey() {
    return (state.imageApiKey || state.apiKey || '').trim();
  }

  function configured() { return state.baseUrl && state.apiKey && (state.model || conversationModel()); }
  function imageConfigured() { return effectiveImageBaseUrl() && effectiveImageApiKey() && state.imageModel; }
  function parseSourcedModelRef(value, fallback = 'image') {
    const raw = (value || '').trim();
    const match = raw.match(/^(chat|image):(.+)$/i);
    if (match) return { source: match[1].toLowerCase(), model: match[2].trim(), value: `${match[1].toLowerCase()}:${match[2].trim()}` };

    const hasImageModel = state.imageModelsCache.includes(raw) || DEFAULT_IMAGE_MODELS.includes(raw);
    const hasChatModel = state.modelsCache.includes(raw) || raw === state.model || raw === conversationModel();
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
      return { baseUrl: state.baseUrl, apiKey: state.apiKey, source: 'chat', model: ref.model };
    }
    return { baseUrl: effectiveImageBaseUrl(), apiKey: effectiveImageApiKey(), source: 'image', model: ref.model };
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
    imageGenerateBtn: $('image-generate-btn'),
    // Settings modal
    settingsModal: $('settings-modal'),
    modalClose: $('modal-close'),
    settingsChatTab: $('settings-chat-tab'),
    settingsImageTab: $('settings-image-tab'),
    settingsChatPanel: $('settings-chat-panel'),
    settingsImagePanel: $('settings-image-panel'),
    cfgBaseUrl: $('cfg-base-url'),
    cfgApiKey: $('cfg-api-key'),
    cfgModelSelect: $('cfg-model-select'),
    cfgRefreshModels: $('cfg-refresh-models'),
    cfgModelManual: $('cfg-model-manual'),
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
    imageViewerCopy: $('image-viewer-copy'),
    imageViewerDownload: $('image-viewer-download'),
    cfgSave: $('cfg-save'),
    cfgCancel: $('cfg-cancel'),
    cfgExportConfig: $('cfg-export-config'),
    cfgImportFile: $('cfg-import-file'),
    cfgImportInput: $('cfg-import-input'),
    chatStorageSummary: $('chat-storage-summary'),
    imageStorageSummary: $('image-storage-summary'),
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
  function updateModelBadge() {
    dom.currentModel.textContent = state.mode === 'image'
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
    dom.imageWorkspace.setAttribute('aria-hidden', mode === 'image' ? 'false' : 'true');
  }

  function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    persist();
  }

  function isMobile() {
    return window.innerWidth <= 768;
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
    if (state.mode === 'image') {
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
    dom.imageGenerateBtn.disabled = !dom.imagePrompt.value.trim() || state.isGeneratingImage;
    const hasRefs = imageReferenceList().length > 0;
    dom.imageGenerateBtn.title = hasRefs ? '编辑图片' : '生成图片';
    dom.imageGenerateBtn.setAttribute('aria-label', hasRefs ? '编辑图片' : '生成图片');
    dom.imageGenerateBtn.dataset.tooltip = hasRefs ? '编辑图片' : '生成图片';
    dom.imageOptimizeBtn.disabled = !dom.imagePrompt.value.trim() || state.isOptimizingImagePrompt || state.isGeneratingImage;
    dom.imageOptimizeBtn.title = state.isOptimizingImagePrompt ? '正在优化提示词' : '优化提示词';
    dom.imageOptimizeBtn.setAttribute('aria-label', state.isOptimizingImagePrompt ? '正在优化提示词' : '优化提示词');
    dom.imageOptimizeBtn.dataset.tooltip = state.isOptimizingImagePrompt ? '正在优化提示词' : '优化提示词';
    dom.imageOptimizeBtn.classList.toggle('active', state.isOptimizingImagePrompt);
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
    if (mode === 'image' && !imageConfigured()) {
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
    const target = state.mode === 'image' ? dom.imageModelSlot : dom.chatModelSlot;
    if (target && dom.modelDropdown.parentElement !== target) target.appendChild(dom.modelDropdown);
  }

  function resetSidebarBulkMode() {
    state.sidebarBulkMode = false;
    state.sidebarSelectedIds.clear();
    state.sidebarVisibleIds = [];
  }

  function switchMode(mode) {
    pauseActivePolls();
    if (state.mode !== mode) resetSidebarBulkMode();
    state.mode = mode;
    dom.modeChatBtn.parentElement.classList.toggle('is-image', mode === 'image');
    dom.modeChatBtn.classList.toggle('active', mode === 'chat');
    dom.modeImageBtn.classList.toggle('active', mode === 'image');
    updateModeA11y(mode);
    dom.messages.classList.toggle('hidden', mode !== 'chat');
    dom.welcome.classList.toggle('hidden', mode !== 'chat' || !!currentConv()?.messages.length);
    dom.inputArea.classList.toggle('hidden', mode !== 'chat');
    updateConversationTokenSummary();
    dom.imageWorkspace.classList.toggle('hidden', mode !== 'image');
    dom.imageInputArea.classList.toggle('hidden', mode !== 'image');
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
      scrollImageWorkspaceToBottom(false);
      updateImageGenerateBtn();
      dom.imagePrompt.focus();
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

  function appConfigSnapshot(includeSecrets = false) {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      mode: state.mode,
      chat: {
        baseUrl: state.baseUrl,
        apiKey: includeSecrets ? state.apiKey : '',
        model: state.model,
        models: state.modelsCache,
      },
      image: {
        baseUrl: state.imageBaseUrl,
        apiKey: includeSecrets ? state.imageApiKey : '',
        model: state.imageModel,
        mapModel: state.imageMapModel,
        promptModel: state.imagePromptModel,
        models: state.imageModelsCache,
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
    const models = state.mode === 'image'
      ? mergeUnique([state.imageModel], state.imageModelsCache, DEFAULT_IMAGE_MODELS)
      : mergeUnique([conversationModel()], state.modelsCache);
    const current = state.mode === 'image' ? state.imageModel : conversationModel();
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

  function populateSelectFromCache(selectEl, opts = {}) {
    const models = opts.image ? state.imageModelsCache : state.modelsCache;
    const current = opts.image ? state.imageModel : state.model;
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

  function populateImageMapModelSelect() {
    const current = parseMapModelRef(state.imageMapModel);
    dom.cfgImageMapModelSelect.innerHTML = '<option value="">关闭映射，使用绘画模型</option>';
    mergeUnique([conversationModel(), state.model], state.modelsCache, current.source === 'chat' ? [current.model] : []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = `chat:${m}`;
      opt.textContent = `${m} · 对话`;
      if (opt.value === current.value) opt.selected = true;
      dom.cfgImageMapModelSelect.appendChild(opt);
    });
    mergeUnique([state.imageModel], state.imageModelsCache, DEFAULT_IMAGE_MODELS, current.source === 'image' ? [current.model] : []).forEach(m => {
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
    mergeUnique([conversationModel(), state.model], state.modelsCache, current.source === 'chat' ? [current.model] : []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = `chat:${m}`;
      opt.textContent = `${m} · 对话`;
      if (opt.value === current.value) opt.selected = true;
      dom.cfgImagePromptModelSelect.appendChild(opt);
    });
    mergeUnique([state.imageModel], state.imageModelsCache, DEFAULT_IMAGE_MODELS, current.source === 'image' ? [current.model] : []).forEach(m => {
      const opt = document.createElement('option');
      opt.value = `image:${m}`;
      opt.textContent = `${m} · 绘画`;
      if (opt.value === current.value) opt.selected = true;
      dom.cfgImagePromptModelSelect.appendChild(opt);
    });
  }

  async function refreshModelsForSelect(baseUrl, apiKey, selectEl, refreshBtn, opts = {}) {
    if (!baseUrl || !apiKey) {
      alert('请先填写 Base URL 和 API Key');
      return;
    }
    refreshBtn.disabled = true;
    selectEl.innerHTML = '<option value="">加载中...</option>';
    try {
      const models = await fetchModels(baseUrl, apiKey);
      if (opts.image) state.imageModelsCache = mergeUnique(DEFAULT_IMAGE_MODELS, models);
      else state.modelsCache = models;
      persist();
      populateSelectFromCache(selectEl, opts);
      selectEl.value = (opts.image ? state.imageModel : state.model) || models[0] || '';
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
    const streamUrl = requestUrl(state.baseUrl, '/chat/completions');
    const swAvailable = navigator.serviceWorker?.controller;

    if (swAvailable) {
      // === SW proxy mode: SW makes the only fetch, page reads from IndexedDB ===
      navigator.serviceWorker.controller.postMessage({
        type: 'start-stream',
        ownerId: state.appClientId,
        url: streamUrl,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.apiKey}` },
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
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.apiKey}` },
          body: JSON.stringify(reqBody),
          signal: controller.signal,
        });

        if (!resp.ok) {
          let errText = await resp.text().catch(() => '');
          if (/stream_options|include_usage/i.test(errText)) {
            const fallbackBody = OwnChatStream.removeStreamOptions(reqBody);
            resp = await apiFetch(streamUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.apiKey}` },
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
    dom.cfgBaseUrl.value = state.baseUrl;
    dom.cfgApiKey.value = state.apiKey;
    populateSelectFromCache(dom.cfgModelSelect);
    dom.cfgModelSelect.value = state.model;
    dom.cfgModelManual.value = '';
    dom.cfgModelManual.placeholder = `手动填写模型，当前 ${state.model || '未配置'}`;
    dom.cfgImageBaseUrl.value = effectiveImageBaseUrl();
    dom.cfgImageApiKey.value = effectiveImageApiKey();
    populateSelectFromCache(dom.cfgImageModelSelect, { image: true });
    dom.cfgImageModelSelect.value = state.imageModel;
    dom.cfgImageModelManual.value = '';
    dom.cfgImageModelManual.placeholder = state.imageModel
      ? `手动填写模型，当前 ${state.imageModel}`
      : '手动填写适配 OpenAI Image 协议的模型';
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
    if (state.mode === 'image') updateSidebar();
    try {
      const imageSession = await getImageSession();
      state.imageJobs = await imageDbGetAllJobs();
      const changedJobs = [];
      state.imageJobs.forEach(job => {
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
    } finally {
      state.isImageHistoryLoading = false;
      if (state.mode === 'image') {
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
      state.imageDefaults = sanitizeImageParams(DEFAULT_IMAGE_PARAMS);
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
    return job && item.out ? { job, out: item.out } : null;
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
      if (state.mode === 'image' && state.imageJobs.some(job => job.status === 'generating')) {
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
      return sum + imageJobReplies(job).reduce((n, reply) => n + (reply.outputs?.length || 0), 0);
    }, 0);
    return {
      conversationCount: state.conversations.length,
      chatBytes: Attachments.storedTextBytes(chatJson) + attachmentBytes,
      attachmentCount: attachmentIds.size,
      orphanAttachmentCount,
      imageJobCount: jobs.length,
      imageOutputCount: outputCount,
      imageBytes: Attachments.storedTextBytes(jobs),
    };
  }

  async function updateStorageStats() {
    if (!dom.chatStorageSummary || !dom.imageStorageSummary) return;
    const token = Date.now();
    state.storageStatsToken = token;
    dom.chatStorageSummary.textContent = '正在统计...';
    dom.imageStorageSummary.textContent = '正在统计...';
    try {
      const stats = await collectStorageStats();
      if (state.storageStatsToken !== token) return;
      const orphanText = stats.orphanAttachmentCount ? `，待清理附件 ${stats.orphanAttachmentCount} 个` : '';
      dom.chatStorageSummary.textContent = `${stats.conversationCount} 条对话，附件 ${stats.attachmentCount} 个${orphanText}，占用 ${storageText(stats.chatBytes)}`;
      dom.imageStorageSummary.textContent = `${stats.imageJobCount} 条绘画，图片 ${stats.imageOutputCount} 张，占用 ${storageText(stats.imageBytes)}`;
    } catch (e) {
      console.warn('Storage stats failed:', e);
      if (state.storageStatsToken !== token) return;
      dom.chatStorageSummary.textContent = '统计失败';
      dom.imageStorageSummary.textContent = '统计失败';
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
      setImageReferences([]);
      resetSidebarBulkMode();
      persist([KEYS.currentImageJobId]);
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

  function renderImageWorkspace() {
    const selected = currentImageJob();
    const isLoading = state.isImageHistoryLoading;
    dom.imageEmpty.classList.toggle('hidden', isLoading || !!selected);
    dom.imageGallery.innerHTML = ImageRenderer.renderWorkspace(selected, {
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
      },
    }).html;
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
          imageEndpoint: { baseUrl: effectiveImageBaseUrl(), apiKey: effectiveImageApiKey() },
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
              renderImageWorkspace();
              scrollImageWorkspaceToBottom(false);
              updateImageGenerateBtn();
            }
            return false;
          }
          if (session.status === 'complete') {
            completeImageJobFromSession(job, activeReply, session, startedAt);
            applyImageProgressFromSession(job, activeReply, session);
            if (refs.length) { setImageReferences([]); renderImageRefPreview(); }
            const totalCount = Math.max(1, Number(session.totalCount) || Number(activeReply?.params?.count) || 1);
            const outputCount = (activeReply.outputs || []).length;
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
        // === Fallback: no SW, direct fetch; multi-image mode intentionally fans out concurrent n=1 requests ===
        timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
        const requestSingleImage = () => state.imageMapModel
          ? ImageApi.requestMappedImage(imageMapEndpoint(), prompt, params, refs, controller.signal)
          : refs.length
            ? ImageApi.requestImageEdit({ baseUrl: effectiveImageBaseUrl(), apiKey: effectiveImageApiKey() }, state.imageModel, prompt, params, refs, controller.signal)
            : ImageApi.requestOneImage({ baseUrl: effectiveImageBaseUrl(), apiKey: effectiveImageApiKey() }, state.imageModel, prompt, params, controller.signal);
        const successes = [];
        let directCompleted = 0;
        let directFailed = 0;
        const updateDirectProgress = () => {
          const nextOutputs = successes.flatMap(ImageCore.imageResultOutputs);
          const progress = {
            total: requestCount,
            completed: Math.min(requestCount, directCompleted),
            success: nextOutputs.length,
            failed: directFailed,
          };
          activeReply.progress = progress;
          job.progress = progress;
          if (nextOutputs.length) {
            activeReply.outputs = nextOutputs;
            activeReply.usage = ImageCore.combineImageUsages(successes.map(ImageCore.imageResultUsage));
            job.outputs = nextOutputs;
            job.usage = activeReply.usage;
          }
          persist();
          imageDbPutJob(job);
          updateSidebar();
          renderImageWorkspace();
          scrollImageWorkspaceToBottom(false);
          updateImageGenerateBtn();
        };
        const settled = await Promise.allSettled(Array.from({ length: requestCount }, async () => {
          try {
            const result = await requestSingleImage();
            if (!ImageCore.imageResultOutputs(result).length) throw new Error('接口未返回可显示的图片数据');
            successes.push(result);
            directCompleted += 1;
            updateDirectProgress();
            return result;
          } catch (error) {
            directCompleted += 1;
            directFailed += 1;
            updateDirectProgress();
            throw error;
          }
        }));
        if (controller.signal.aborted) {
          const abortError = new Error('Aborted');
          abortError.name = 'AbortError';
          throw abortError;
        }
        const nextOutputs = successes.flatMap(ImageCore.imageResultOutputs);
        if (nextOutputs.length === 0) {
          const firstError = settled.find(item => item.status === 'rejected')?.reason;
          throw firstError || new Error('接口未返回可显示的图片数据');
        }
        setImageJobDone(job, activeReply, nextOutputs, startedAt, ImageCore.combineImageUsages(successes.map(ImageCore.imageResultUsage)));
        activeReply.progress = {
          total: requestCount,
          completed: requestCount,
          success: nextOutputs.length,
          failed: directFailed,
        };
        job.progress = activeReply.progress;
        if (refs.length) { setImageReferences([]); renderImageRefPreview(); }
        showToast(nextOutputs.length >= requestCount ? '图片已生成' : `已生成 ${nextOutputs.length}/${requestCount} 张，部分请求失败`);
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
    if (state.mode === 'image') {
      state.currentImageJobId = null;
      dom.imagePrompt.value = '';
      setImageReferences([]);
      renderImageRefPreview();
      syncImageParams();
      persist();
      updateSidebar();
      renderImageWorkspace();
      closeSidebarMobile();
      dom.imagePrompt.focus();
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
    const typeLabel = state.mode === 'image' ? '绘画记录' : '对话';
    if (!confirm(`确认删除选中的 ${ids.length} 条${typeLabel}？此操作不可恢复。`)) return;
    const idSet = new Set(ids);
    if (state.mode === 'image') {
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
      scrollImageWorkspaceToBottom(false);
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

    if (state.mode === 'image') {
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
        persist();
        updateSidebar();
        syncImageParams();
        renderImageWorkspace();
        scrollImageWorkspaceToBottom(false);
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
  [dom.cfgImageModelSelect, dom.cfgImageModelManual, dom.cfgImageMapModelSelect, dom.cfgImageMapModelManual].forEach(el => {
    el.addEventListener('change', syncImageBackgroundSupport);
    el.addEventListener('input', syncImageBackgroundSupport);
  });
  dom.clearChatStorage.addEventListener('click', clearChatStorage);
  dom.clearImageStorage.addEventListener('click', clearImageStorage);

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
    refreshModelsForSelect(dom.cfgBaseUrl.value.trim(), dom.cfgApiKey.value.trim(), dom.cfgModelSelect, dom.cfgRefreshModels);
  });

  dom.cfgRefreshImageModels.addEventListener('click', async () => {
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
      hideSettings();
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
    const b = dom.cfgBaseUrl.value.trim();
    const k = dom.cfgApiKey.value.trim();
    const m = dom.cfgModelManual.value.trim() || dom.cfgModelSelect.value;
    const ib = dom.cfgImageBaseUrl.value.trim();
    const ik = dom.cfgImageApiKey.value.trim();
    const im = dom.cfgImageModelManual.value.trim() || dom.cfgImageModelSelect.value;
    const imm = dom.cfgImageMapModelManual.value.trim();
    const mapModel = parseMapModelRef(imm || dom.cfgImageMapModelSelect.value).value;
    const ipm = dom.cfgImagePromptModelManual.value.trim();
    const promptModel = parsePromptModelRef(ipm || dom.cfgImagePromptModelSelect.value).value;

    const needChat = !savingImageTab;
    const needImage = savingImageTab;

    if (needChat && (!b || !k || !m)) { alert('请填写对话配置项并选择模型'); return; }
    if (needImage && (!ib || !ik || !im)) { alert('请填写绘画配置项并选择模型'); return; }

    if (needChat || b || k || dom.cfgModelManual.value.trim()) {
      if (!b || !k || !m) { alert('对话配置需要同时填写 Base URL、API Key 和模型'); return; }
      state.baseUrl = normalizeUrl(b);
      state.apiKey = k;
      state.model = m;
      state.modelsCache = mergeUnique([m], state.modelsCache);
      if (currentConv() && !currentConv().model) currentConv().model = m;
    }
    if (needImage || ib || ik || dom.cfgImageModelManual.value.trim()) {
      if (!ib || !ik || !im) { alert('绘画配置需要同时填写 Base URL、API Key 和模型'); return; }
      state.imageBaseUrl = normalizeUrl(ib);
      state.imageApiKey = ik;
      state.imageModel = im;
      state.imageMapModel = mapModel || '';
      state.imagePromptModel = promptModel || '';
      state.imageModelsCache = mergeUnique([im], state.imageModelsCache, DEFAULT_IMAGE_MODELS);
      state.imageDefaults = sanitizeImageParams(state.imageDefaults);
    }
    persist();
    updateModelBadge();
    syncImageParams();
    hideSettings();
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
    state.baseUrl = normalizeUrl(b);
    state.apiKey = k;
    state.model = m;
    if (currentConv() && !currentConv().model) currentConv().model = m;
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
    if (state.mode === 'image') {
      state.imageModel = opt.dataset.model;
      state.imageDefaults = sanitizeImageParams(state.imageDefaults);
      persist([KEYS.imageModel]);
      syncImageParams();
    }
    else {
      const conv = currentConv() || newConv();
      conv.model = opt.dataset.model;
      state.modelsCache = mergeUnique([conv.model], state.modelsCache);
      persist([KEYS.conversations, KEYS.currentConvId, KEYS.modelsCache]);
    }
    updateModelBadge();
    closeModelDropdown();
    updateSendBtn();
    updateImageGenerateBtn();
    showToast(`已切换到 ${state.mode === 'image' ? state.imageModel : conversationModel()}`);
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
    if (imageReferenceList().length >= MAX_IMAGE_REFS) return false;
    const name = opts.name || file.name || pastedImageName(file, opts.index || 0);
    const reader = new FileReader();
    reader.onload = ev => {
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
      if (imageReferenceList().length >= MAX_IMAGE_REFS) return true;
      const name = opts.pasted ? (file.name || pastedImageName(file, index)) : file.name;
      if (setImageReferenceFile(file, { name, index })) added += 1;
      return false;
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
    const success = Math.max(0, Number(session?.successCount) || parseImageSessionOutputs(session).length || 0);
    const failed = Math.max(0, Number(session?.failedCount) || 0);
    const completed = Math.max(success + failed, Number(session?.completedCount) || 0);
    const progress = {
      total,
      completed: Math.min(total, completed),
      success,
      failed,
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
            updateSidebar(); renderImageWorkspace(); updateImageGenerateBtn();
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
  } else {
    dom.sidebar.classList.toggle('collapsed', state.sidebarCollapsed);
  }
  document.documentElement.removeAttribute('data-boot-sidebar');
  if (state.mode === 'image') state.isImageHistoryLoading = true;
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
        switchMode(state.mode === 'image' ? 'image' : 'chat');
      } else {
        state.mode = 'chat';
        switchMode('chat');
        hideSetup();
        if (!currentConv()) { newConv(); updateSidebar(); syncConvParams(); renderMessages(); }
      }
    });
  });
})();
