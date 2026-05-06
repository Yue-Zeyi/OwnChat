(function () {
  'use strict';

  // ===== Storage =====
  const KEYS = {
    baseUrl: 'nc_base_url',
    apiKey: 'nc_api_key',
    model: 'nc_model',
    modelsCache: 'nc_models_cache',
    conversations: 'nc_conversations',
    currentConvId: 'nc_current_conv_id',
    tokenStats: 'nc_token_stats',
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

  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch (e) { console.warn('localStorage save failed:', k, e); }
  }
  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }

  // ===== Token Estimation =====
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

  // ===== Markdown Renderer =====
  function renderMd(raw) {
    if (!raw) return '';
    // Extract fenced code blocks first to protect their content
    const codeBlocks = [];
    let html = raw.replace(/```([\w#+.\-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      const highlighted = highlightCode(code.trimEnd(), lang);
      const langLabel = lang ? `<span class="code-lang">${esc(lang)}</span>` : '';
      const headerBar = langLabel ? `<div class="code-header">${langLabel}<button class="code-copy-btn" type="button" title="复制代码"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>` : `<div class="code-header"><button class="code-copy-btn" type="button" title="复制代码"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div>`;
      codeBlocks.push(`<div class="code-block">${headerBar}<pre><code>${highlighted}</code></pre></div>`);
      return `\x00CODE${idx}\x00`;
    });

    // Extract inline code to protect from other transforms
    const inlineCodes = [];
    html = html.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(`<code>${esc(code)}</code>`);
      return `\x00ICODE${idx}\x00`;
    });

    html = esc(html);

    // Tables (must be before paragraph split)
    html = html.replace(/^(\|.+\|)\n(\|[\s:|\-]+)\n((\|.+\|\n?)+)/gm, (_, header, sep, body) => {
      const heads = header.split('|').filter(c => c.trim()).map(c => `<th>${renderInline(c.trim())}</th>`);
      const rows = body.trim().split('\n').map(row => {
        const cells = row.split('|').filter(c => c.trim()).map(c => `<td>${renderInline(c.trim())}</td>`);
        return `<tr>${cells.join('')}</tr>`;
      });
      return `<table><thead><tr>${heads.join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
    });

    // Headings (with inline rendering)
    html = html.replace(/^#### (.+)$/gm, (_, t) => `<h4>${renderInline(t)}</h4>`);
    html = html.replace(/^### (.+)$/gm, (_, t) => `<h3>${renderInline(t)}</h3>`);
    html = html.replace(/^## (.+)$/gm, (_, t) => `<h2>${renderInline(t)}</h2>`);
    html = html.replace(/^# (.+)$/gm, (_, t) => `<h1>${renderInline(t)}</h1>`);

    // Horizontal rules
    html = html.replace(/^---+$/gm, '<hr>');

    // Blockquotes (support nested > and multi-line)
    html = html.replace(/^(&gt;.*)$/gm, (_, line) => {
      const content = line.replace(/^&gt;\s?/, '');
      return `<blockquote>${renderInline(content)}</blockquote>`;
    });
    html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

    // Task lists (- [ ] / - [x])
    html = html.replace(/^(\s*)- \[([ xX])\] (.+)$/gm, (_, indent, checked, text) => {
      const marker = checked.trim() ? '✓' : '';
      const cls = checked.trim() ? 'task-checked' : 'task-unchecked';
      return `${indent}<div class="task-item ${cls}"><span class="task-box">${marker}</span>${renderInline(text)}</div>`;
    });

    // Unordered lists (multi-line, supports nesting via indentation)
    html = html.replace(/((?:^[ \t]*[-*+] .+\n?)+)/gm, (block) => {
      const items = block.trim().split('\n').map(line => {
        const m = line.match(/^(\s*)[-*+]\s(.+)$/);
        if (!m) return '';
        const depth = m[1].length;
        return `<li class="list-depth-${Math.min(depth, 4)}">${renderInline(m[2])}</li>`;
      });
      return `<ul>${items.join('')}</ul>`;
    });

    // Ordered lists (multi-line)
    html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
      const items = block.trim().split('\n').map(line => {
        const m = line.match(/^(\s*)\d+\.\s(.+)$/);
        if (!m) return '';
        return `<li>${renderInline(m[2])}</li>`;
      });
      return `<ol>${items.join('')}</ol>`;
    });

    // Paragraphs — split by double newline
    html = html.split(/\n{2,}/).map(p => {
      p = p.trim();
      if (!p) return '';
      if (/^<(div|pre|table|h[1-4]|ul|ol|blockquote|hr|p)/.test(p)) return p;
      if (p.startsWith('\x00CODE')) return p;
      p = p.replace(/\n/g, '<br>');
      return `<p>${renderInline(p)}</p>`;
    }).join('\n');

    // Restore code blocks
    html = html.replace(/\x00CODE(\d+)\x00/g, (_, idx) => codeBlocks[idx]);
    // Restore inline codes
    html = html.replace(/\x00ICODE(\d+)\x00/g, (_, idx) => inlineCodes[idx]);

    return html;
  }

  // Inline rendering (links/images before emphasis, protected by placeholders)
  function renderInline(text) {
    const inlineParts = [];
    const stash = html => {
      const idx = inlineParts.length;
      inlineParts.push(html);
      return `\x00PART${idx}\x00`;
    };

    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      const safeUrl = sanitizeUrl(url, { image: true });
      return stash(`<img src="${safeUrl}" alt="${esc(stripMd(alt))}" loading="lazy">`);
    });
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const safeUrl = sanitizeUrl(url);
      return stash(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${esc(stripMd(label))}</a>`);
    });
    text = text.replace(/&lt;code&gt;([\s\S]*?)&lt;\/code&gt;/g, (_, code) => stash(`<code>${esc(code)}</code>`));
    text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
    text = text.replace(/\*\*([^\n*](?:[^\n]*?[^\n*])?)\*\*/g, '<strong>$1</strong>');
    // Italic: avoid lookbehind for broader browser compatibility.
    text = text.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
    text = text.replace(/\*\*([^*\n]{1,80})$/g, '$1');
    text = text.replace(/(^|[\s([])\*([^\s*\n][^*\n]{0,79})$/g, '$1$2');
    text = text.replace(/\x00PART(\d+)\x00/g, (_, idx) => inlineParts[idx]);
    return text;
  }

  function esc(t) { return t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  function stripMd(t) {
    return t.replace(/[*_~`[\]]/g, '');
  }

  function sanitizeUrl(rawUrl, opts = {}) {
    const url = rawUrl.trim().replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if (!url) return '#';
    if (opts.image && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(url)) return esc(url);
    try {
      const parsed = new URL(url, window.location.href);
      const allowed = opts.image ? ['http:', 'https:'] : ['http:', 'https:', 'mailto:', 'tel:'];
      if (allowed.includes(parsed.protocol)) return esc(url);
    } catch {
      if (!opts.image && /^(#|\/(?!\/)|\.{1,2}\/)/.test(url)) return esc(url);
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
    // Collect all highlight regions first, then build output in one pass (no placeholders)
    const regions = [];
    const add = (start, end, cls) => regions.push({ start, end, cls });

    // Multi-line comments
    for (const m of code.matchAll(/\/\*[\s\S]*?\*\//g)) add(m.index, m.index + m[0].length, 'hl-comment');
    // Single-line // comments
    for (const m of code.matchAll(/\/\/.*$/gm)) add(m.index, m.index + m[0].length, 'hl-comment');
    // # comments (Python/Ruby/Shell only)
    if (/^(py|python|rb|ruby|sh|bash|yaml|yml|toml|r|perl|pl)/i.test(lang)) {
      for (const m of code.matchAll(/#.*$/gm)) add(m.index, m.index + m[0].length, 'hl-comment');
    }
    // Strings
    for (const m of code.matchAll(/"(?:[^"\\]|\\.)*"/g)) add(m.index, m.index + m[0].length, 'hl-string');
    for (const m of code.matchAll(/'(?:[^'\\]|\\.)*'/g)) add(m.index, m.index + m[0].length, 'hl-string');
    // Keywords
    const kwSet = new Set(['function','return','if','else','for','while','do','switch','case','break','continue','class','extends','new','this','super','import','export','from','default','async','await','try','catch','finally','throw','const','let','var','def','elif','lambda','with','as','in','not','is','True','False','None','print','self','yield','raise','except','pass','assert','struct','enum','interface','type','namespace','using','public','private','protected','static','final','void','int','float','double','string','bool','char','long','short','byte','sizeof','null','undefined','true','false','typeof','instanceof']);
    for (const m of code.matchAll(/\b([a-zA-Z_]\w*)\b/g)) {
      if (kwSet.has(m[1])) add(m.index, m.index + m[0].length, 'hl-keyword');
    }
    // Numbers
    for (const m of code.matchAll(/\b(\d+\.?\d*)\b/g)) add(m.index, m.index + m[0].length, 'hl-number');
    // Function calls (identifier before parenthesis, skip keywords)
    for (const m of code.matchAll(/\b([a-zA-Z_]\w*)(\s*\()/g)) {
      if (!kwSet.has(m[1])) add(m.index, m.index + m[1].length, 'hl-func');
    }

    // Sort by start position, then longer matches first (for overlap priority)
    regions.sort((a, b) => a.start - b.start || b.end - a.end - (a.end - a.start));

    // Remove overlapping regions (keep earlier/longer ones)
    const kept = [];
    for (const r of regions) {
      if (kept.length && r.start < kept[kept.length - 1].end) continue;
      kept.push(r);
    }

    // Build output HTML: escape plain parts, wrap highlighted parts
    let html = '';
    let pos = 0;
    for (const r of kept) {
      if (r.start > pos) html += esc(code.slice(pos, r.start));
      html += `<span class="${r.cls}">${esc(code.slice(r.start, r.end))}</span>`;
      pos = r.end;
    }
    if (pos < code.length) html += esc(code.slice(pos));
    return html;
  }

  // ===== State =====
  const DEFAULT_IMAGE_MODELS = ['gpt-image-2', 'gpt-image-2-2026-04-21', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3', 'dall-e-2'];
  const DEFAULT_IMAGE_PARAMS = { size: 'auto', quality: 'auto', outputFormat: 'png', background: 'auto' };

  const state = {
    mode: load(KEYS.mode) || 'chat',
    baseUrl: load(KEYS.baseUrl) || '',
    apiKey: load(KEYS.apiKey) || '',
    model: load(KEYS.model) || '',
    modelsCache: load(KEYS.modelsCache) || [],
    conversations: load(KEYS.conversations) || [],
    currentConvId: load(KEYS.currentConvId) || null,
    tokenStats: load(KEYS.tokenStats) || { input: 0, output: 0, total: 0 },
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
    chatAbortController: null,
    isGeneratingImage: false,
    imageAbortController: null,
    imageProgressTimer: null,
    isOptimizingImagePrompt: false,
    viewerImage: null,
    imageViewerTransform: { scale: 1, x: 0, y: 0 },
    imageViewerDragging: null,
    imageViewerTouch: null,
    imageRef: null,
    pendingFiles: [],
    sidebarSearch: '',
    pendingImportConfig: null,
  };

  function persist() {
    save(KEYS.mode, state.mode);
    save(KEYS.baseUrl, state.baseUrl);
    save(KEYS.apiKey, state.apiKey);
    save(KEYS.model, state.model);
    save(KEYS.modelsCache, state.modelsCache);
    save(KEYS.conversations, state.conversations);
    save(KEYS.currentConvId, state.currentConvId);
    save(KEYS.tokenStats, state.tokenStats);
    save(KEYS.sidebarCollapsed, state.sidebarCollapsed);
    save(KEYS.theme, state.theme);
    save(KEYS.imageBaseUrl, state.imageBaseUrl);
    save(KEYS.imageApiKey, state.imageApiKey);
    save(KEYS.imageModel, state.imageModel);
    save(KEYS.imageMapModel, state.imageMapModel);
    save(KEYS.imagePromptModel, state.imagePromptModel);
    save(KEYS.imageModelsCache, state.imageModelsCache);
    save(KEYS.currentImageJobId, state.currentImageJobId);
    save(KEYS.imageDefaults, state.imageDefaults);
  }

  function cleanConfigUrl() {
    if (!window.history?.replaceState) return;
    const url = new URL(window.location.href);
    ['config', 'config_b64', 'oc_config', 'oc_config_b64'].forEach(k => url.searchParams.delete(k));
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

  function parseImportConfig(text) {
    const cfg = JSON.parse(text);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('配置必须是 JSON 对象');
    return cfg;
  }

  function importConfigSummary(cfg) {
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

  function applyImportedConfig(cfg) {
    const summary = importConfigSummary(cfg);
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
    state.imageModelsCache = mergeUnique(
      [state.imageModel, state.imageMapModel, state.imagePromptModel],
      summary.imageModels,
      state.imageModelsCache,
      DEFAULT_IMAGE_MODELS,
    );
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
    const summary = importConfigSummary(cfg);
    dom.configImportPreview.innerHTML = [
      ['模式', summary.mode || '不修改'],
      ['对话 Base URL', summary.chatBaseUrl || '不修改'],
      ['对话 API Key', maskKey(summary.chatApiKey)],
      ['对话模型', summary.chatModel || '不修改'],
      ['绘画 Base URL', summary.imageBaseUrl || '不修改'],
      ['绘画 API Key', maskKey(summary.imageApiKey)],
      ['绘画模型', summary.imageModel || '不修改'],
      ['映射模型', summary.hasImageMapModel ? (summary.imageMapModel || '关闭') : '不修改'],
      ['提示词优化模型', summary.hasImagePromptModel ? (summary.imagePromptModel || '关闭') : '不修改'],
    ].map(([k, v]) => `<div class="config-preview-row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
    dom.configImportModal.classList.remove('hidden');
  }

  function hideConfigImportConfirm() {
    state.pendingImportConfig = null;
    dom.configImportModal.classList.add('hidden');
  }

  function importConfigFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('config') || params.get('oc_config');
    const rawB64 = params.get('config_b64') || params.get('oc_config_b64');
    if (!raw && !rawB64) return false;
    try {
      const text = rawB64 ? decodeBase64Url(rawB64) : raw;
      showConfigImportConfirm(parseImportConfig(text));
      cleanConfigUrl();
      return true;
    } catch (e) {
      cleanConfigUrl();
      alert(`导入接口配置失败: ${e.message}`);
      return false;
    }
  }

  function currentConv() {
    return state.conversations.find(c => c.id === state.currentConvId);
  }

  function newConv() {
    const conv = { id: Date.now().toString(), title: '新对话', messages: [], createdAt: Date.now(), temperature: 0.7, topP: 1, maxTokens: 4096, systemPrompt: '' };
    state.conversations.unshift(conv);
    state.currentConvId = conv.id;
    persist();
    return conv;
  }

  function configured() { return state.baseUrl && state.apiKey && state.model; }
  function imageConfigured() { return state.imageBaseUrl && state.imageApiKey && state.imageModel; }
  function imagePromptOptimizerConfigured() { return state.imageBaseUrl && state.imageApiKey && state.imagePromptModel; }

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
    const hints = [`无法连接到 ${target}`];
    try {
      const parsed = new URL(url, window.location.href);
      if (window.location.protocol === 'https:' && parsed.protocol === 'http:') {
        hints.push('当前页面是 HTTPS，但接口是 HTTP，浏览器会拦截混合内容');
      }
      if (parsed.origin !== window.location.origin) {
        hints.push('这是跨域请求，服务端必须允许 CORS；如果服务不支持，请改用同源代理地址');
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

  function httpError(status, message, url) {
    const error = new Error(message || `HTTP ${status}`);
    error.diagnostics = [
      `请求地址: ${url}`,
      `HTTP 状态: ${status}`,
      `错误信息: ${message || `HTTP ${status}`}`,
      `当前模式: ${state.mode}`,
      `对话模型: ${state.model || '未配置'}`,
      `绘画模型: ${state.imageModel || '未配置'}`,
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

  // ===== IndexedDB for large image history =====
  const IMAGE_DB = { name: 'ownchat_image_db', version: 1, store: 'jobs' };
  let imageDbPromise = null;
  let imageDbWarned = false;

  function openImageDb() {
    if (imageDbPromise) return imageDbPromise;
    imageDbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(IMAGE_DB.name, IMAGE_DB.version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IMAGE_DB.store)) {
          const store = db.createObjectStore(IMAGE_DB.store, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return imageDbPromise;
  }

  async function imageDbGetAllJobs() {
    const legacyJobs = load('nc_image_jobs') || [];
    try {
      const db = await openImageDb();
      const jobs = await new Promise((resolve, reject) => {
        const tx = db.transaction(IMAGE_DB.store, 'readonly');
        const req = tx.objectStore(IMAGE_DB.store).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      const merged = mergeJobs(jobs, legacyJobs).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      if (legacyJobs.length) {
        await Promise.allSettled(legacyJobs.map(imageDbPutJob));
        localStorage.removeItem('nc_image_jobs');
      }
      return merged;
    } catch (e) {
      console.warn('Image history load failed:', e);
      return legacyJobs;
    }
  }

  function mergeJobs(a, b) {
    const map = new Map();
    [...a, ...b].forEach(job => { if (job?.id) map.set(job.id, job); });
    return Array.from(map.values());
  }

  async function estimateImageDbUsage() {
    if (navigator.storage?.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        return estimate.usage || 0;
      } catch { /* ignore */ }
    }
    return state.imageJobs.reduce((sum, job) => {
      return sum + (job.outputs || []).reduce((n, out) => n + imageByteSize(out), 0);
    }, 0);
  }

  async function imageDbPutJob(job) {
    try {
      const db = await openImageDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IMAGE_DB.store, 'readwrite');
        tx.objectStore(IMAGE_DB.store).put(job);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('Image history save failed:', e);
      if (!imageDbWarned) {
        imageDbWarned = true;
        showToast('图片历史保存失败，当前页面仍可查看');
      }
    }
  }

  async function imageDbDeleteJob(id) {
    try {
      const db = await openImageDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IMAGE_DB.store, 'readwrite');
        tx.objectStore(IMAGE_DB.store).delete(id);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('Image history delete failed:', e);
    }
  }

  // ===== DOM =====
  const $ = id => document.getElementById(id);

  const dom = {
    sidebar: $('sidebar'),
    sidebarToggle: $('sidebar-toggle'),
    convList: $('conv-list'),
    newChatBtn: $('new-chat-btn'),
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
    userInput: $('user-input'),
    sendBtn: $('send-btn'),
    inputArea: $('input-area'),
    imageInputArea: $('image-input-area'),
    imagePrompt: $('image-prompt'),
    imageSize: $('image-size'),
    imageQuality: $('image-quality'),
    imageFormat: $('image-format'),
    imageBackground: $('image-background'),
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
    imageViewerCopy: $('image-viewer-copy'),
    imageViewerDownload: $('image-viewer-download'),
    cfgSave: $('cfg-save'),
    cfgCancel: $('cfg-cancel'),
    cfgExportSafe: $('cfg-export-safe'),
    cfgExportFull: $('cfg-export-full'),
    cfgImportFile: $('cfg-import-file'),
    cfgImportInput: $('cfg-import-input'),
    imageHistoryStats: $('image-history-stats'),
    imageHistoryTrim: $('image-history-trim'),
    imageHistoryClear: $('image-history-clear'),
    imageHistorySummary: $('image-history-summary'),
    configImportModal: $('config-import-modal'),
    configImportPreview: $('config-import-preview'),
    configImportClose: $('config-import-close'),
    configImportApply: $('config-import-apply'),
    configImportCancel: $('config-import-cancel'),
    // Input params
    paramTemperature: $('param-temperature'),
    paramTopP: $('param-top-p'),
    paramMaxTokens: $('param-max-tokens'),
    convSettingsBtn: $('conv-settings-btn'),
    convSettingsPanel: $('conv-settings-panel'),
    convRenameInput: $('conv-rename-input'),
    convRoleInput: $('conv-role-input'),
    // File upload
    attachBtn: $('attach-btn'),
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

  // ===== Render Functions =====
  function updateModelBadge() {
    dom.currentModel.textContent = state.mode === 'image'
      ? (state.imageMapModel ? `映射 ${state.imageMapModel}` : (state.imageModel || '未配置'))
      : (state.model || '未配置');
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
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

  function updateSidebar() {
    if (state.mode === 'image') {
      dom.sidebarSearch.placeholder = '搜索绘画...';
      const q = state.sidebarSearch.trim().toLowerCase();
      const imageJobs = q
        ? state.imageJobs.filter(j => `${j.title || ''} ${j.prompt || ''} ${j.model || ''}`.toLowerCase().includes(q))
        : state.imageJobs;
      dom.newChatBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="M21 15l-5-5L5 21"/>
        </svg>
        新绘画
      `;
      dom.convList.innerHTML = imageJobs.map(j => `
        <div class="conv-item ${j.id === state.currentImageJobId ? 'active' : ''}" data-id="${j.id}">
          <span class="conv-item-title">${esc(j.title || j.prompt || '未命名绘画')}</span>
          <button class="conv-item-delete" type="button" title="删除">&times;</button>
        </div>
      `).join('') || `<div class="sidebar-empty">没有匹配的绘画</div>`;
      return;
    }
    dom.sidebarSearch.placeholder = '搜索对话...';
    const q = state.sidebarSearch.trim().toLowerCase();
    const conversations = q
      ? state.conversations.filter(c => {
          const body = (c.messages || []).map(messageTextContent).join(' ');
          return `${c.title || ''} ${c.systemPrompt || ''} ${body}`.toLowerCase().includes(q);
        })
      : state.conversations;
    dom.newChatBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      新对话
    `;
    dom.convList.innerHTML = conversations.map(c => `
      <div class="conv-item ${c.id === state.currentConvId ? 'active' : ''}" data-id="${c.id}">
        <span class="conv-item-title">${esc(c.title)}</span>
        <button class="conv-item-rename" type="button" title="重命名">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
        </button>
        <button class="conv-item-delete" type="button" title="删除">&times;</button>
      </div>
    `).join('') || `<div class="sidebar-empty">没有匹配的对话</div>`;
  }

  function updateSendBtn() {
    dom.sendBtn.disabled = !state.isStreaming && !dom.userInput.value.trim();
    dom.sendBtn.classList.toggle('is-stopping', state.isStreaming);
    dom.sendBtn.title = state.isStreaming ? '停止生成' : '发送';
    dom.sendBtn.setAttribute('aria-label', state.isStreaming ? '停止生成' : '发送');
  }

  function updateImageGenerateBtn() {
    dom.imageGenerateBtn.disabled = !dom.imagePrompt.value.trim() || state.isGeneratingImage;
    dom.imageGenerateBtn.title = state.imageRef ? '编辑图片' : '生成图片';
    dom.imageGenerateBtn.setAttribute('aria-label', state.imageRef ? '编辑图片' : '生成图片');
    dom.imageOptimizeBtn.disabled = !dom.imagePrompt.value.trim() || state.isOptimizingImagePrompt || state.isGeneratingImage;
    dom.imageOptimizeBtn.title = state.isOptimizingImagePrompt ? '正在优化提示词' : '优化提示词';
    dom.imageOptimizeBtn.setAttribute('aria-label', state.isOptimizingImagePrompt ? '正在优化提示词' : '优化提示词');
    dom.imageOptimizeBtn.classList.toggle('active', state.isOptimizingImagePrompt);
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

  function renderImageRefPreview() {
    if (!state.imageRef) {
      dom.imageRefPreview.classList.add('hidden');
      dom.imageRefPreview.innerHTML = '';
      return;
    }
    dom.imageRefPreview.classList.remove('hidden');
    dom.imageRefPreview.innerHTML = `
      <div class="image-ref-card">
        <img src="${esc(state.imageRef.base64)}" alt="${esc(state.imageRef.name || '参考图')}">
        <div class="image-ref-info">
          <div class="image-ref-name">${esc(state.imageRef.name || '参考图')}</div>
          <div class="image-ref-hint">将基于这张图片进行编辑</div>
        </div>
        <button class="image-ref-remove" type="button" title="移除参考图">&times;</button>
      </div>
    `;
  }

  function moveModelDropdown() {
    const target = state.mode === 'image' ? dom.imageModelSlot : dom.chatModelSlot;
    if (target && dom.modelDropdown.parentElement !== target) target.appendChild(dom.modelDropdown);
  }

  function switchMode(mode) {
    state.mode = mode;
    dom.modeChatBtn.parentElement.classList.toggle('is-image', mode === 'image');
    dom.modeChatBtn.classList.toggle('active', mode === 'chat');
    dom.modeImageBtn.classList.toggle('active', mode === 'image');
    dom.messages.classList.toggle('hidden', mode !== 'chat');
    dom.welcome.classList.toggle('hidden', mode !== 'chat' || !!currentConv()?.messages.length);
    dom.inputArea.classList.toggle('hidden', mode !== 'chat');
    dom.imageWorkspace.classList.toggle('hidden', mode !== 'image');
    dom.imageInputArea.classList.toggle('hidden', mode !== 'image');
    moveModelDropdown();
    closeModelDropdown();
    updateModelBadge();
    updateSidebar();
    if (mode === 'chat') {
      renderMessages();
      dom.userInput.focus();
    } else {
      syncImageParams();
      renderImageWorkspace();
      updateImageGenerateBtn();
      dom.imagePrompt.focus();
    }
    persist();
  }

  function toggleSidebar() {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    dom.sidebar.classList.toggle('collapsed', state.sidebarCollapsed);
    if (isMobile()) {
      dom.sidebarBackdrop.classList.toggle('hidden', state.sidebarCollapsed);
    }
    persist();
  }

  // ===== SVG Icons =====
  const SVG_PERSON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
  const SVG_BOT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a2 2 0 0 1 .9 3.73L13 7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 0 2h-1v1a7 7 0 0 1-7 7H7a7 7 0 0 1-7-7v-1H-1a1 1 0 0 1 0-2h1a7 7 0 0 1 7-7h1l.1-1.27A2 2 0 0 1 12 2zM8 15a1 1 0 1 0 2 0 1 1 0 0 0-2 0zm6 0a1 1 0 1 0 2 0 1 1 0 0 0-2 0z"/></svg>';
  const SVG_COPY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const SVG_REFRESH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-8.36L23 10"/></svg>';
  const SVG_EDIT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  const SVG_DOWNLOAD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const SVG_MAXIMIZE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

  // ===== Clipboard =====
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => showToast('已复制到剪贴板')).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); showToast('已复制到剪贴板'); }
    catch { showToast('复制失败，请手动复制'); }
    document.body.removeChild(ta);
  }

  function messageTextContent(msg) {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n\n');
    }
    return '';
  }

  function copyableMessageText(msg) {
    const text = messageTextContent(msg);
    if (msg?.role !== 'assistant') return text;
    return splitThinkTags(text).content.trim();
  }

  function showToast(msg) {
    $('toast-el')?.remove();
    const el = document.createElement('div');
    el.id = 'toast-el'; el.className = 'toast'; el.textContent = msg;
    dom.main.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
  function retryMessage(index) {
    if (state.isStreaming) return;
    const conv = currentConv();
    if (!conv) return;
    const msg = conv.messages[index];
    let userText;
    if (msg.role === 'user') {
      userText = typeof msg.content === 'string' ? msg.content : msg.content.find(p => p.type === 'text')?.text || '';
      conv.messages = conv.messages.slice(0, index);
    } else {
      const prev = conv.messages[index - 1];
      if (prev && prev.role === 'user') { userText = prev.content; conv.messages = conv.messages.slice(0, index - 1); }
      else return;
    }
    persist(); renderMessages(); sendMsg(userText);
  }

  function renderMessages() {
    const conv = currentConv();
    updateModelBadge();
    if (!conv || conv.messages.length === 0) {
      dom.messages.innerHTML = '';
      dom.messages.classList.remove('has-messages');
      dom.welcome.classList.remove('hidden');
      return;
    }

    dom.welcome.classList.add('hidden');
    dom.messages.classList.add('has-messages');

    dom.messages.innerHTML = conv.messages.map((msg, i) => {
      const isUser = msg.role === 'user';
      const avatar = isUser ? SVG_PERSON : SVG_BOT;
      const splitContent = !isUser && typeof msg.content === 'string' ? splitThinkTags(msg.content) : null;
      const reasoningText = !isUser ? (msg.reasoningContent || splitContent?.reasoning || '') : '';
      const mainContent = splitContent?.reasoning ? splitContent.content : msg.content;

      // Build content: thinking block + main content
      let contentHtml = '';
      if (!isUser && reasoningText) {
        const thinkingTimeStr = msg.reasoningTimeMs != null
          ? (msg.reasoningTimeMs >= 1000 ? (msg.reasoningTimeMs / 1000).toFixed(1) + 's' : msg.reasoningTimeMs + 'ms')
          : '';
        contentHtml += `
          <div class="thinking-block">
            <button class="thinking-toggle" type="button">
              <svg class="thinking-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              <span>思考过程</span>${thinkingTimeStr ? ` · ${thinkingTimeStr}` : ''}
            </button>
            <div class="thinking-content"><div class="msg-md">${renderMd(reasoningText)}</div></div>
          </div>
        `;
      }
      // Display user content (text or multimodal with files)
      if (isUser) {
        if (typeof msg.content === 'string') {
          contentHtml += esc(msg.content).replace(/\n/g, '<br>');
        } else {
          // Multimodal: extract text + show images
          const textPart = msg.content.find(p => p.type === 'text')?.text || '';
          contentHtml += esc(textPart).replace(/\n/g, '<br>');
          const imgParts = msg.content.filter(p => p.type === 'image_url');
          if (imgParts.length) {
            contentHtml += `<div class="msg-images">${imgParts.map(p => `<img src="${p.image_url.url}" class="msg-img" loading="lazy">`).join('')}</div>`;
          }
        }
      } else {
        contentHtml += `<div class="msg-md">${renderMd(mainContent)}</div>`;
      }

      // Build meta row: timestamp + latency + tokens + model + actions
      const metaParts = [];
      if (isUser && msg.timestamp) {
        const d = new Date(msg.timestamp);
        const pad = n => String(n).padStart(2, '0');
        metaParts.push(`<span class="msg-meta-item">${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</span>`);
      }
      if (!isUser && reasoningText && msg.reasoningTimeMs != null) {
        metaParts.push(`<span class="msg-meta-item">思考 ${msg.reasoningTimeMs >= 1000 ? (msg.reasoningTimeMs / 1000).toFixed(1) + 's' : msg.reasoningTimeMs + 'ms'}</span>`);
      } else if (!isUser && msg.firstTokenMs !== undefined) {
        metaParts.push(`<span class="msg-meta-item">${msg.firstTokenMs >= 1000 ? (msg.firstTokenMs / 1000).toFixed(1) + 's' : msg.firstTokenMs + 'ms'}</span>`);
      }
      if (msg.tokens) metaParts.push(`<span class="msg-meta-item">~${msg.tokens} tokens</span>`);
      if (!isUser && msg.model) metaParts.push(`<span class="msg-meta-item msg-model-tag">${esc(msg.model)}</span>`);
      metaParts.push(`<button class="msg-action-btn" data-action="copy" data-idx="${i}" title="复制">${SVG_COPY}</button>`);
      if (isUser) metaParts.push(`<button class="msg-action-btn" data-action="edit" data-idx="${i}" title="继续提问">${SVG_EDIT}</button>`);
      if (!isUser) metaParts.push(`<button class="msg-action-btn" data-action="retry" data-idx="${i}" title="重新生成">${SVG_REFRESH}</button>`);
      const metaRow = metaParts.length ? `<div class="msg-meta">${metaParts.join('')}</div>` : '';

      return `
        <div class="chat-msg ${isUser ? 'user' : 'ai'}">
          <div class="chat-msg-inner">
            <div class="chat-msg-avatar">${avatar}</div>
            <div class="chat-msg-body">${contentHtml}${metaRow}</div>
          </div>
        </div>
      `;
    }).join('');

    dom.messages.scrollTop = dom.messages.scrollHeight;
  }

  function addTyping() {
    const el = document.createElement('div');
    el.className = 'chat-msg ai';
    el.id = 'typing-el';
    el.innerHTML = `
      <div class="chat-msg-inner">
        <div class="chat-msg-avatar">${SVG_BOT}</div>
        <div class="chat-msg-body">
          <div class="typing-dots"><span></span><span></span><span></span></div>
        </div>
      </div>
    `;
    dom.messages.classList.add('has-messages');
    dom.welcome.classList.add('hidden');
    dom.messages.appendChild(el);
    dom.messages.scrollTop = dom.messages.scrollHeight;
  }

  function removeTyping() { $('typing-el')?.remove(); }

  function addStreamMsg() {
    const el = document.createElement('div');
    el.className = 'chat-msg ai';
    el.id = 'stream-el';
    el.innerHTML = `
      <div class="chat-msg-inner">
        <div class="chat-msg-avatar">${SVG_BOT}</div>
        <div class="chat-msg-body">
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
    dom.messages.appendChild(el);
    dom.messages.scrollTop = dom.messages.scrollHeight;
    return {
      thinkingMd: el.querySelector('.thinking-content .msg-md'),
      thinkingBlock: el.querySelector('.thinking-block'),
      thinkingLabel: el.querySelector('.thinking-label'),
      contentMd: el.querySelector('.chat-msg-body > .msg-md'),
    };
  }

  function updateStream(el, text) {
    el.innerHTML = renderMd(text);
    dom.messages.scrollTop = dom.messages.scrollHeight;
  }

  function updateThinkingStream(streamEls, reasoningContent, reasoningStartTime, streamStartTime) {
    if (streamEls.thinkingBlock.classList.contains('hidden')) {
      streamEls.thinkingBlock.classList.remove('hidden');
      streamEls.thinkingBlock.classList.add('expanded');
    }
    const thinkingMs = Date.now() - (reasoningStartTime || streamStartTime);
    streamEls.thinkingLabel.textContent = `思考中... · ${thinkingMs >= 1000 ? (thinkingMs / 1000).toFixed(1) + 's' : thinkingMs + 'ms'}`;
    streamEls.thinkingMd.innerHTML = renderMd(reasoningContent);
    dom.messages.scrollTop = dom.messages.scrollHeight;
  }

  // ===== Model Dropdown =====
  function renderModelDropdown() {
    const models = state.mode === 'image' ? state.imageModelsCache : state.modelsCache;
    const current = state.mode === 'image' ? (state.imageMapModel || state.imageModel) : state.model;
    dom.modelDropdownList.innerHTML = `
      <div class="model-dropdown-header">选择模型</div>
      <div class="model-dropdown-scroll">
        ${state.mode === 'image' && state.imageMapModel ? '<div class="model-option model-option-clear" data-clear-map="1">关闭映射，使用绘画模型</div>' : ''}
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
    dom.cfgImageMapModelSelect.innerHTML = '<option value="">关闭映射，使用绘画模型</option>';
    mergeUnique(state.imageModelsCache, state.modelsCache).forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === state.imageMapModel) opt.selected = true;
      dom.cfgImageMapModelSelect.appendChild(opt);
    });
  }

  function populateImagePromptModelSelect() {
    dom.cfgImagePromptModelSelect.innerHTML = '<option value="">关闭提示词优化</option>';
    mergeUnique(state.imageModelsCache, state.modelsCache).forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === state.imagePromptModel) opt.selected = true;
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
      alert('获取模型列表失败: ' + e.message);
    } finally {
      refreshBtn.disabled = false;
    }
  }

  function mergeUnique(...lists) {
    return Array.from(new Set(lists.flat().filter(Boolean)));
  }

  // ===== Send Message =====
  async function sendMsg(userContent) {
    if (!ensureModeConfigured('chat')) return;
    const conv = currentConv();
    if (!conv) return;

    const inputTokens = estimateTokens(userContent);

    // Build user message content (plain text or multimodal)
    const files = state.pendingFiles;
    let userMsgData;
    if (files.length > 0) {
      const contentParts = [{ type: 'text', text: userContent }];
      for (const f of files) {
        if (f.base64) {
          contentParts.push({ type: 'image_url', image_url: { url: f.base64 } });
        } else if (f.text) {
          contentParts.push({ type: 'text', text: `[文件: ${f.name}]\n${f.text}` });
        }
      }
      userMsgData = { role: 'user', content: contentParts, tokens: inputTokens, timestamp: Date.now(), files: files.map(f => ({ name: f.name, type: f.type, base64: f.base64 })) };
    } else {
      userMsgData = { role: 'user', content: userContent, tokens: inputTokens, timestamp: Date.now() };
    }
    conv.messages.push(userMsgData);

    let contextTokens = inputTokens;
    for (const msg of conv.messages.slice(0, -1)) {
      contextTokens += estimateTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    }

    renderMessages();

    // Build API messages (convert multimodal format for API)
    const apiMessages = [];
    if (conv.systemPrompt?.trim()) {
      apiMessages.push({ role: 'system', content: conv.systemPrompt.trim() });
      contextTokens += estimateTokens(conv.systemPrompt);
    }
    apiMessages.push(...conv.messages.map(m => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      return { role: m.role, content: m.content };
    }));

    // Clear pending files after adding to message
    state.pendingFiles = [];
    renderFilePreview();

    state.isStreaming = true;
    const controller = new AbortController();
    state.chatAbortController = controller;
    dom.userInput.disabled = true;
    updateSendBtn();

    addTyping();
    let assistantRawContent = '';
    let assistantContent = '';
    let apiReasoningContent = '';
    let tagReasoningContent = '';
    let reasoningContent = '';
    let firstTokenTime = null;
    let reasoningStartTime = null;
    let reasoningEndTime = null;
    const streamStartTime = Date.now();

    try {
      const reqBody = { model: state.model, messages: apiMessages, stream: true };
      reqBody.temperature = conv.temperature;
      reqBody.top_p = conv.topP;
      reqBody.max_tokens = conv.maxTokens;
      const resp = await apiFetch(requestUrl(state.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.apiKey}` },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: { message: `HTTP ${resp.status}` } }));
        throw httpError(resp.status, err.error?.message || `HTTP ${resp.status}`, requestUrl(state.baseUrl, '/chat/completions'));
      }

      removeTyping();
      const streamEls = addStreamMsg();

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;
            // Reasoning: support both "reasoning_content" (DeepSeek/QwQ) and "thinking" (Claude-style)
            const reasoningDelta = delta?.reasoning_content || delta?.thinking || '';
            const contentDelta = delta?.content || '';

            if (reasoningDelta) {
              if (reasoningStartTime === null) reasoningStartTime = Date.now();
              apiReasoningContent += reasoningDelta;
              reasoningContent = [apiReasoningContent, tagReasoningContent].filter(Boolean).join('\n\n');
              updateThinkingStream(streamEls, reasoningContent, reasoningStartTime, streamStartTime);
            }

            if (contentDelta) {
              if (firstTokenTime === null) firstTokenTime = Date.now() - streamStartTime;
              assistantRawContent += contentDelta;
              const splitContent = splitThinkTags(assistantRawContent);
              assistantContent = splitContent.content;
              tagReasoningContent = splitContent.reasoning;
              reasoningContent = [apiReasoningContent, tagReasoningContent].filter(Boolean).join('\n\n');
              if (reasoningContent) {
                if (reasoningStartTime === null) reasoningStartTime = Date.now();
                updateThinkingStream(streamEls, reasoningContent, reasoningStartTime, streamStartTime);
              }
              if (reasoningContent && !splitContent.openThink && reasoningEndTime === null) {
                reasoningEndTime = Date.now();
                streamEls.thinkingBlock.classList.remove('expanded');
                const thinkingMs = reasoningEndTime - (reasoningStartTime || streamStartTime);
                streamEls.thinkingLabel.textContent = `思考过程 · ${thinkingMs >= 1000 ? (thinkingMs / 1000).toFixed(1) + 's' : thinkingMs + 'ms'}`;
              }
              updateStream(streamEls.contentMd, assistantContent);
            }
          } catch { /* skip */ }
        }
      }

      const firstTokenMs = firstTokenTime;
      const outputTokens = estimateTokens(assistantContent);
      const msgData = { role: 'assistant', content: assistantContent, tokens: outputTokens, model: state.model };
      if (firstTokenMs !== null) msgData.firstTokenMs = firstTokenMs;
      if (reasoningContent) {
        msgData.reasoningContent = reasoningContent;
        msgData.reasoningTimeMs = reasoningEndTime ? reasoningEndTime - (reasoningStartTime || streamStartTime) : null;
      }
      conv.messages.push(msgData);

      if (conv.messages.filter(m => m.role === 'user').length === 1) {
        conv.title = userContent.slice(0, 30) + (userContent.length > 30 ? '...' : '');
      }

      state.tokenStats.input += contextTokens;
      state.tokenStats.output += outputTokens;
      state.tokenStats.total = state.tokenStats.input + state.tokenStats.output;

      persist();
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
        const stoppedMsg = { role: 'assistant', content: stoppedContent, tokens: estimateTokens(assistantContent), model: state.model };
        if (reasoningContent) stoppedMsg.reasoningContent = reasoningContent;
        conv.messages.push(stoppedMsg);
      } else {
        const detail = e.diagnostics ? `\n\n\`\`\`text\n${e.diagnostics}\n\`\`\`` : '';
        conv.messages.push({ role: 'assistant', content: `**错误**: ${e.message}${detail}`, tokens: 0 });
      }
      renderMessages();
    } finally {
      state.isStreaming = false;
      state.chatAbortController = null;
      dom.userInput.disabled = false;
      dom.userInput.focus();
      updateSendBtn();
    }
  }

  // ===== Auto-resize =====
  function autoResize() {
    dom.userInput.style.height = 'auto';
    dom.userInput.style.height = Math.min(dom.userInput.scrollHeight, 150) + 'px';
  }

  // ===== Settings Modal =====
  function showSettings(tab = state.mode) {
    dom.cfgBaseUrl.value = state.baseUrl;
    dom.cfgApiKey.value = state.apiKey;
    populateSelectFromCache(dom.cfgModelSelect);
    dom.cfgModelSelect.value = state.model;
    dom.cfgModelManual.value = '';
    dom.cfgModelManual.placeholder = `手动填写模型，当前 ${state.model || '未配置'}`;
    dom.cfgImageBaseUrl.value = state.imageBaseUrl;
    dom.cfgImageApiKey.value = state.imageApiKey;
    populateSelectFromCache(dom.cfgImageModelSelect, { image: true });
    dom.cfgImageModelSelect.value = state.imageModel;
    dom.cfgImageModelManual.value = '';
    dom.cfgImageModelManual.placeholder = `手动填写模型，当前 ${state.imageModel || 'gpt-image-2'}`;
    populateImageMapModelSelect();
    dom.cfgImageMapModelSelect.value = state.imageMapModel;
    dom.cfgImageMapModelManual.value = '';
    dom.cfgImageMapModelManual.placeholder = state.imageMapModel ? `当前 ${state.imageMapModel}` : '可选，如 gpt-5.5';
    populateImagePromptModelSelect();
    dom.cfgImagePromptModelSelect.value = state.imagePromptModel;
    dom.cfgImagePromptModelManual.value = '';
    dom.cfgImagePromptModelManual.placeholder = state.imagePromptModel ? `当前 ${state.imagePromptModel}` : '可选，如 gpt-5.5';
    switchSettingsTab(tab === 'image' ? 'image' : 'chat');
    dom.settingsModal.classList.remove('hidden');
  }

  function hideSettings() {
    dom.settingsModal.classList.add('hidden');
  }

  function switchSettingsTab(tab) {
    const isImage = tab === 'image';
    dom.settingsChatTab.classList.toggle('active', !isImage);
    dom.settingsImageTab.classList.toggle('active', isImage);
    dom.settingsChatPanel.classList.toggle('hidden', isImage);
    dom.settingsImagePanel.classList.toggle('hidden', !isImage);
  }

  // ===== Setup Overlay =====
  function showSetup() {
    dom.setupBaseUrl.value = state.baseUrl;
    dom.setupApiKey.value = state.apiKey;
    populateSelectFromCache(dom.setupModelSelect);
    dom.setupModelSelect.value = state.model;
    dom.setupOverlay.classList.remove('hidden');
  }

  function hideSetup() {
    dom.setupOverlay.classList.add('hidden');
  }

  async function loadImageHistory() {
    state.imageJobs = await imageDbGetAllJobs();
    state.imageJobs.forEach(job => {
      if (job.status === 'generating') {
        job.status = 'error';
        job.error = '上次生成因页面刷新或关闭而中断，请点击“重绘”重新生成。';
        job.durationMs = job.startedAt ? Date.now() - job.startedAt : job.durationMs;
        imageDbPutJob(job);
      }
    });
    if (state.currentImageJobId && !state.imageJobs.some(j => j.id === state.currentImageJobId)) {
      state.currentImageJobId = state.imageJobs[0]?.id || null;
      persist();
    }
    if (state.mode === 'image') {
      updateSidebar();
      renderImageWorkspace();
    }
  }

  // ===== Image Mode =====
  function syncImageParams() {
    dom.imageSize.value = state.imageDefaults.size;
    dom.imageQuality.value = state.imageDefaults.quality;
    dom.imageFormat.value = state.imageDefaults.outputFormat;
    dom.imageBackground.value = state.imageDefaults.background;
  }

  function saveImageParams() {
    state.imageDefaults = {
      size: dom.imageSize.value,
      quality: dom.imageQuality.value,
      outputFormat: dom.imageFormat.value,
      background: dom.imageBackground.value,
    };
    persist();
  }

  function currentImageJob() {
    return state.imageJobs.find(j => j.id === state.currentImageJobId);
  }

  function dataUrlForImage(out, fallbackFormat) {
    const format = out.format || fallbackFormat || 'png';
    if (out.url) return sanitizeUrl(out.url, { image: true });
    return `data:image/${format};base64,${out.b64}`;
  }

  function imageByteSize(out) {
    if (Number.isFinite(out?.bytes)) return out.bytes;
    if (!out?.b64) return 0;
    const clean = out.b64.replace(/\s/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(mb >= 100 ? 0 : 2)} MB`;
  }

  function normalizeImageFormat(format) {
    const value = (format || '').toLowerCase().replace(/^image\//, '');
    if (value === 'jpg') return 'jpeg';
    return value || '';
  }

  function imageOutputMeta(out, fallbackFormat) {
    const size = out?.width && out?.height ? `${out.width}x${out.height}` : '尺寸读取中';
    const format = normalizeImageFormat(out?.format || fallbackFormat || '') || '未知格式';
    const bytes = formatBytes(imageByteSize(out)) || '大小未知';
    return [size, format.toUpperCase(), bytes].filter(Boolean);
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
    const out = job?.outputs?.[index];
    if (!job || !out || !img?.naturalWidth || !img?.naturalHeight) return;
    const nextWidth = img.naturalWidth;
    const nextHeight = img.naturalHeight;
    if (out.width === nextWidth && out.height === nextHeight && out.bytes) return;
    out.width = nextWidth;
    out.height = nextHeight;
    out.bytes = imageByteSize(out);
    imageDbPutJob(job);
    const resultEl = Array.from(dom.imageGallery.querySelectorAll('.image-result'))
      .find(el => el.dataset.job === jobId && parseInt(el.dataset.index, 10) === index);
    const metaEl = resultEl?.querySelector('.image-result-meta');
    if (metaEl) metaEl.innerHTML = imageOutputMeta(out, job.params?.outputFormat).map(esc).join('<span>·</span>');
    updateRemoteImageOutputMeta(job, out, metaEl);
  }

  function imageFilename(job, out) {
    const ext = out?.format || job.params?.outputFormat || 'png';
    return `${(job.title || 'ownchat-image').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60)}.${ext}`;
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

  function openImageViewer(job, out) {
    state.viewerImage = { jobId: job.id, index: job.outputs.indexOf(out) };
    resetImageViewerTransform();
    dom.imageViewerImg.src = dataUrlForImage(out, job.params?.outputFormat);
    dom.imageViewer.classList.remove('hidden');
  }

  function closeImageViewer() {
    dom.imageViewer.classList.add('hidden');
    dom.imageViewerImg.src = '';
    state.viewerImage = null;
    state.imageViewerDragging = null;
  }

  function currentViewerImage() {
    if (!state.viewerImage) return null;
    const job = state.imageJobs.find(j => j.id === state.viewerImage.jobId);
    const out = job?.outputs?.[state.viewerImage.index];
    return job && out ? { job, out } : null;
  }

  function clampImageScale(scale) {
    return Math.min(8, Math.max(0.25, scale));
  }

  function applyImageViewerTransform() {
    const t = state.imageViewerTransform;
    dom.imageViewerImg.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
    dom.imageViewerImg.classList.toggle('is-zoomed', t.scale > 1.01);
  }

  function resetImageViewerTransform() {
    state.imageViewerTransform = { scale: 1, x: 0, y: 0 };
    state.imageViewerDragging = null;
    applyImageViewerTransform();
  }

  function zoomImageViewer(e) {
    if (dom.imageViewer.classList.contains('hidden')) return;
    e.preventDefault();
    const current = state.imageViewerTransform;
    const nextScale = clampImageScale(current.scale * (e.deltaY < 0 ? 1.16 : 1 / 1.16));
    if (Math.abs(nextScale - current.scale) < 0.001) return;

    const rect = dom.imageViewerImg.getBoundingClientRect();
    const cx = e.clientX - (rect.left + rect.width / 2);
    const cy = e.clientY - (rect.top + rect.height / 2);
    const ratio = nextScale / current.scale;
    state.imageViewerTransform = {
      scale: nextScale,
      x: current.x - cx * (ratio - 1),
      y: current.y - cy * (ratio - 1),
    };
    applyImageViewerTransform();
  }

  function startImageViewerDrag(e) {
    if (dom.imageViewer.classList.contains('hidden')) return;
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    e.preventDefault();
    state.imageViewerDragging = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: state.imageViewerTransform.x,
      originY: state.imageViewerTransform.y,
    };
    dom.imageViewerImg.setPointerCapture?.(e.pointerId);
    dom.imageViewer.classList.add('is-panning');
  }

  function moveImageViewerDrag(e) {
    const drag = state.imageViewerDragging;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    state.imageViewerTransform.x = drag.originX + e.clientX - drag.startX;
    state.imageViewerTransform.y = drag.originY + e.clientY - drag.startY;
    applyImageViewerTransform();
  }

  function endImageViewerDrag(e) {
    const drag = state.imageViewerDragging;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    state.imageViewerDragging = null;
    dom.imageViewerImg.releasePointerCapture?.(e.pointerId);
    dom.imageViewer.classList.remove('is-panning');
  }

  function touchDistance(touches) {
    const [a, b] = touches;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function touchCenter(touches) {
    const [a, b] = touches;
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  function startImageViewerTouch(e) {
    if (dom.imageViewer.classList.contains('hidden') || e.touches.length !== 2) return;
    e.preventDefault();
    state.imageViewerTouch = {
      distance: touchDistance(e.touches),
      center: touchCenter(e.touches),
      scale: state.imageViewerTransform.scale,
      x: state.imageViewerTransform.x,
      y: state.imageViewerTransform.y,
    };
  }

  function moveImageViewerTouch(e) {
    const start = state.imageViewerTouch;
    if (!start || e.touches.length !== 2) return;
    e.preventDefault();
    const center = touchCenter(e.touches);
    const nextScale = clampImageScale(start.scale * (touchDistance(e.touches) / start.distance));
    state.imageViewerTransform = {
      scale: nextScale,
      x: start.x + center.x - start.center.x,
      y: start.y + center.y - start.center.y,
    };
    applyImageViewerTransform();
  }

  function endImageViewerTouch(e) {
    if (e.touches.length < 2) state.imageViewerTouch = null;
  }

  function estimateImageSeconds(params) {
    const qualityFactor = params.quality === 'high' ? 130 : params.quality === 'medium' ? 95 : params.quality === 'low' ? 60 : 90;
    const sizeFactor = params.size === '3840x2160' || params.size === '2160x3840'
      ? 95
      : params.size === '1536x1024' || params.size === '1024x1536'
        ? 35
        : params.size === 'auto' ? 15 : 20;
    const editFactor = state.imageRef ? 35 : 0;
    return Math.max(60, qualityFactor + sizeFactor + editFactor);
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }

  function imageTimeoutMs(params) {
    return Math.max(10 * 60 * 1000, estimateImageSeconds(params) * 1000 * 3);
  }

  function startImageProgressTimer() {
    stopImageProgressTimer();
    state.imageProgressTimer = setInterval(() => {
      if (state.mode === 'image' && state.imageJobs.some(job => job.status === 'generating')) {
        renderImageWorkspace();
      }
    }, 1000);
  }

  function stopImageProgressTimer() {
    if (!state.imageProgressTimer) return;
    clearInterval(state.imageProgressTimer);
    state.imageProgressTimer = null;
  }

  function cancelImageGeneration(reason = '已取消生成') {
    const job = state.imageJobs.find(j => j.status === 'generating');
    if (!job) return;
    if (state.imageAbortController) state.imageAbortController.abort();
    job.status = 'cancelled';
    job.error = reason;
    job.durationMs = Date.now() - (job.startedAt || job.createdAt);
    state.isGeneratingImage = false;
    state.imageAbortController = null;
    stopImageProgressTimer();
    persist();
    imageDbPutJob(job);
    renderImageWorkspace();
    updateSidebar();
    updateImageGenerateBtn();
  }

  async function updateImageHistorySummary() {
    const usage = await estimateImageDbUsage();
    const outputCount = state.imageJobs.reduce((sum, job) => sum + (job.outputs?.length || 0), 0);
    dom.imageHistorySummary.textContent = `绘画历史 ${state.imageJobs.length} 条，图片 ${outputCount} 张，浏览器存储约 ${formatBytes(usage) || '未知'}`;
  }

  async function trimImageHistory(keep = 20) {
    const sorted = state.imageJobs.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const keepJobs = sorted.slice(0, keep);
    const removeJobs = sorted.slice(keep);
    if (!removeJobs.length) {
      showToast('无需清理');
      updateImageHistorySummary();
      return;
    }
    if (!confirm(`将删除 ${removeJobs.length} 条较早的绘画历史，确认继续？`)) return;
    state.imageJobs = keepJobs;
    if (state.currentImageJobId && !state.imageJobs.some(j => j.id === state.currentImageJobId)) {
      state.currentImageJobId = state.imageJobs[0]?.id || null;
    }
    await Promise.allSettled(removeJobs.map(j => imageDbDeleteJob(j.id)));
    persist();
    updateSidebar();
    renderImageWorkspace();
    updateImageHistorySummary();
    showToast('已清理绘画历史');
  }

  async function clearImageHistory() {
    if (!state.imageJobs.length) {
      showToast('没有绘画历史');
      updateImageHistorySummary();
      return;
    }
    if (!confirm(`确认删除全部 ${state.imageJobs.length} 条绘画历史？此操作不可恢复。`)) return;
    const ids = state.imageJobs.map(j => j.id);
    state.imageJobs = [];
    state.currentImageJobId = null;
    await Promise.allSettled(ids.map(imageDbDeleteJob));
    persist();
    updateSidebar();
    renderImageWorkspace();
    updateImageHistorySummary();
    showToast('绘画历史已清空');
  }

  function renderImageWorkspace() {
    const selected = currentImageJob();
    const jobs = selected ? [selected] : state.imageJobs;
    dom.imageEmpty.classList.toggle('hidden', state.imageJobs.length > 0);
    dom.imageGallery.innerHTML = jobs.map(job => {
      const meta = [
        job.model,
        job.mapModel ? `映射 ${job.mapModel}` : '',
        job.params?.size,
        job.params?.quality !== 'auto' ? job.params?.quality : '',
        job.durationMs ? `耗时 ${formatDuration(job.durationMs)}` : '',
        new Date(job.createdAt).toLocaleString(),
      ].filter(Boolean).map(esc).join(' · ');
      const outputs = (job.outputs || []).map((out, i) => {
        const outputMeta = imageOutputMeta(out, job.params?.outputFormat).map(esc).join('<span>·</span>');
        return `
        <div class="image-result" data-job="${esc(job.id)}" data-index="${i}">
          <img src="${esc(dataUrlForImage(out, job.params?.outputFormat))}" alt="${esc(job.prompt)}" loading="lazy" class="image-preview">
          <div class="image-result-meta">${outputMeta}</div>
          <div class="image-result-actions">
            <button class="msg-action-btn image-action" data-action="view" data-job="${job.id}" data-index="${i}" title="放大查看">${SVG_MAXIMIZE}</button>
            <button class="msg-action-btn image-action" data-action="use-as-ref" data-job="${job.id}" data-index="${i}" title="以图编辑">${SVG_EDIT}</button>
            <button class="msg-action-btn image-action" data-action="copy-image" data-job="${job.id}" data-index="${i}" title="复制图片">${SVG_COPY}</button>
            <button class="msg-action-btn image-action" data-action="download" data-job="${job.id}" data-index="${i}" title="下载">${SVG_DOWNLOAD}</button>
          </div>
        </div>
      `;
      }).join('');
      const inputImage = job.inputImage
        ? `<div class="image-input-ref">
            <img src="${esc(job.inputImage.base64)}" alt="${esc(job.inputImage.name || '参考图')}">
            <span>参考图：${esc(job.inputImage.name || '生成图')}</span>
          </div>`
        : '';
      const waitedMs = Date.now() - (job.startedAt || job.createdAt);
      const estimatedMs = (job.estimatedSeconds || estimateImageSeconds(job.params || DEFAULT_IMAGE_PARAMS)) * 1000;
      const progress = job.status === 'generating'
        ? `<div class="image-progress">
            <div class="image-spinner"></div>
            <div class="image-progress-body">
              <div class="image-progress-title">正在生成图片 · 已等待 ${formatDuration(waitedMs)}</div>
              <div class="image-progress-note">预计约 ${formatDuration(estimatedMs)}，高峰期、参考图编辑或高质量图片可能更久。请勿刷新或关闭页面。</div>
            </div>
            <button class="btn-secondary image-action image-cancel-btn" data-action="cancel" data-job="${job.id}" type="button">取消</button>
          </div>`
        : '';
      return `
        <article class="image-job-card" data-id="${job.id}">
          <div class="image-job-header">
            <div>
              <h2>${esc(job.title || '未命名绘画')}</h2>
              <div class="image-job-meta">${meta}</div>
            </div>
            <div class="image-job-actions">
              <button class="btn-secondary image-action" data-action="reuse" data-job="${job.id}" type="button">复用</button>
              <button class="btn-secondary image-action" data-action="retry" data-job="${job.id}" type="button">${job.status === 'generating' ? '生成中' : '重绘'}</button>
            </div>
          </div>
          <p class="image-job-prompt">${esc(job.prompt)}</p>
          ${inputImage}
          ${progress}
          ${job.error ? `<div class="image-error">${esc(job.error)}</div>` : ''}
          <div class="image-results">${outputs}</div>
        </article>
      `;
    }).join('');
  }

  function parseImageOutputs(data, format) {
    return (data.data || []).map(item => ({
      b64: item.b64_json || '',
      url: item.url || '',
      revisedPrompt: item.revised_prompt || '',
      format: normalizeImageFormat(item.output_format || item.mime_type || format),
      bytes: item.b64_json ? imageByteSize({ b64: item.b64_json }) : 0,
      createdAt: Date.now(),
    })).filter(item => item.b64 || item.url);
  }

  function parseResponseImageOutputs(data, format) {
    const outputs = [];
    const scan = value => {
      if (!value) return;
      if (Array.isArray(value)) { value.forEach(scan); return; }
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
      Object.keys(value).forEach(k => scan(value[k]));
    };
    scan(data.output || data);
    return outputs;
  }

  function imageToolOptions(params) {
    const opts = { type: 'image_generation' };
    if (params.size !== 'auto') opts.size = params.size;
    if (params.quality !== 'auto') opts.quality = params.quality;
    if (params.outputFormat) opts.output_format = params.outputFormat;
    if (params.background !== 'auto') opts.background = params.background;
    return opts;
  }

  function mappedImageInput(prompt, ref) {
    if (!ref) return prompt.trim();
    return [{
      role: 'user',
      content: [
        { type: 'input_text', text: prompt.trim() },
        { type: 'input_image', image_url: ref.base64 },
      ],
    }];
  }

  async function requestMappedImage(prompt, params, ref = null, signal = null) {
    const url = requestUrl(state.imageBaseUrl, '/responses');
    const body = {
      model: state.imageMapModel,
      input: mappedImageInput(prompt, ref),
      tools: [imageToolOptions(params)],
      tool_choice: 'required',
    };
    let resp = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.imageApiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      body.tool_choice = { type: 'image_generation' };
      resp = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.imageApiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    }
    if (!resp.ok && (body.tools[0].output_format || body.tools[0].background || body.tools[0].quality || body.tools[0].size)) {
      const fallback = {
        model: state.imageMapModel,
        input: mappedImageInput(prompt, ref),
        tools: [{ type: 'image_generation' }],
        tool_choice: 'required',
      };
      resp = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.imageApiKey}` },
        body: JSON.stringify(fallback),
        signal,
      });
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: { message: `HTTP ${resp.status}` } }));
      throw httpError(resp.status, err.error?.message || `HTTP ${resp.status}`, url);
    }
    return parseResponseImageOutputs(await resp.json(), params.outputFormat);
  }

  function buildImageRequestBody(prompt, params) {
    const body = {
      model: state.imageModel,
      prompt: prompt.trim(),
      n: 1,
    };
    if (params.size !== 'auto') body.size = params.size;
    if (params.quality !== 'auto') body.quality = params.quality;
    if (params.outputFormat && !/^dall-e/i.test(state.imageModel)) body.output_format = params.outputFormat;
    if (params.background !== 'auto') body.background = params.background;
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

  async function optimizeImagePrompt() {
    if (!imagePromptOptimizerConfigured()) {
      showSettings('image');
      showToast('请先配置提示词优化模型');
      return;
    }
    const prompt = dom.imagePrompt.value.trim();
    if (!prompt || state.isOptimizingImagePrompt || state.isGeneratingImage) return;
    const model = state.imagePromptModel;
    state.isOptimizingImagePrompt = true;
    updateImageGenerateBtn();
    showToast('正在优化提示词...');
    try {
      const resp = await apiFetch(requestUrl(state.imageBaseUrl, '/chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.imageApiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          messages: [
            {
              role: 'system',
              content: '你是专业图像生成提示词编辑器。把用户的中文或英文需求优化成更适合图像生成模型的提示词。只输出优化后的提示词，不要解释，不要使用 Markdown。保留用户核心意图，补充主体、构图、风格、光线、色彩、细节、画面质量。不要加入违反安全或版权的内容。',
            },
            {
              role: 'user',
              content: `优化这个绘画提示词：\n${prompt}`,
            },
          ],
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: { message: `HTTP ${resp.status}` } }));
        throw httpError(resp.status, err.error?.message || `HTTP ${resp.status}`, requestUrl(state.imageBaseUrl, '/chat/completions'));
      }
      const optimized = extractChatText(await resp.json()).replace(/^["“]|["”]$/g, '').trim();
      if (!optimized) throw new Error('接口未返回优化后的提示词');
      dom.imagePrompt.value = optimized;
      saveImageParams();
      updateImageGenerateBtn();
      showToast('提示词已优化');
    } catch (e) {
      showToast('优化失败');
      alert(`优化提示词失败: ${e.message}\n\n请确认绘画设置里的“提示词优化模型”支持 /chat/completions，并且绘画 Base URL 与 API Key 可用。`);
    } finally {
      state.isOptimizingImagePrompt = false;
      updateImageGenerateBtn();
    }
  }

  async function requestOneImage(prompt, params, signal = null) {
    const url = requestUrl(state.imageBaseUrl, '/images/generations');
    let body = buildImageRequestBody(prompt, params);
    let resp = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.imageApiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok && (body.output_format || body.background || body.quality)) {
      body = { model: state.imageModel, prompt: prompt.trim(), n: 1 };
      if (params.size !== 'auto') body.size = params.size;
      resp = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.imageApiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: { message: `HTTP ${resp.status}` } }));
      throw httpError(resp.status, err.error?.message || `HTTP ${resp.status}`, url);
    }
    return parseImageOutputs(await resp.json(), params.outputFormat);
  }

  function dataUrlToBlob(dataUrl) {
    const [header, data] = dataUrl.split(',');
    const mime = header.match(/data:([^;]+)/)?.[1] || 'image/png';
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function filenameForBlob(name, blob) {
    const ext = blob.type.includes('jpeg') ? 'jpg' : blob.type.includes('webp') ? 'webp' : 'png';
    const base = (name || 'reference').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60);
    return `${base || 'reference'}.${ext}`;
  }

  async function requestImageEdit(prompt, params, ref, signal = null) {
    const url = requestUrl(state.imageBaseUrl, '/images/edits');
    const form = new FormData();
    const refBlob = dataUrlToBlob(ref.base64);
    form.append('model', state.imageModel);
    form.append('prompt', prompt.trim());
    form.append('image', refBlob, filenameForBlob(ref.name, refBlob));
    if (params.size !== 'auto') form.append('size', params.size);
    if (params.quality !== 'auto') form.append('quality', params.quality);
    if (params.outputFormat && !/^dall-e/i.test(state.imageModel)) form.append('output_format', params.outputFormat);
    if (params.background !== 'auto') form.append('background', params.background);

    let resp = await apiFetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.imageApiKey}` },
      body: form,
      signal,
    });
    if (!resp.ok && (form.has('quality') || form.has('output_format') || form.has('background'))) {
      const fallback = new FormData();
      fallback.append('model', state.imageModel);
      fallback.append('prompt', prompt.trim());
      fallback.append('image', refBlob, filenameForBlob(ref.name, refBlob));
      if (params.size !== 'auto') fallback.append('size', params.size);
      resp = await apiFetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${state.imageApiKey}` },
        body: fallback,
        signal,
      });
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: { message: `HTTP ${resp.status}` } }));
      throw httpError(resp.status, err.error?.message || `HTTP ${resp.status}`, url);
    }
    return parseImageOutputs(await resp.json(), params.outputFormat);
  }

  async function generateImage(prompt, params = state.imageDefaults, retryJob = null) {
    if (!ensureModeConfigured('image')) return;
    if (!prompt.trim() || state.isGeneratingImage) return;

    state.isGeneratingImage = true;
    const controller = new AbortController();
    state.imageAbortController = controller;
    updateImageGenerateBtn();
    const startedAt = Date.now();
    const ref = state.imageRef ? Object.assign({}, state.imageRef) : null;
    const estimatedSeconds = estimateImageSeconds(params);
    const job = retryJob || {
      id: startedAt.toString(),
      title: prompt.trim().slice(0, 30) + (prompt.trim().length > 30 ? '...' : ''),
      prompt: prompt.trim(),
      model: state.imageModel,
      mapModel: state.imageMapModel,
      createdAt: startedAt,
      params: Object.assign({}, params),
      inputImage: ref ? { name: ref.name, type: ref.type, base64: ref.base64 } : null,
      outputs: [],
      error: null,
      status: 'generating',
      startedAt,
      estimatedSeconds,
      durationMs: null,
    };
    if (!retryJob) {
      state.imageJobs.unshift(job);
      state.currentImageJobId = job.id;
    } else {
      job.model = state.imageModel;
      job.mapModel = state.imageMapModel;
      job.params = Object.assign({}, params);
      job.inputImage = ref ? { name: ref.name, type: ref.type, base64: ref.base64 } : job.inputImage || null;
      job.error = null;
      job.outputs = [];
      job.status = 'generating';
      job.startedAt = startedAt;
      job.estimatedSeconds = estimatedSeconds;
      job.durationMs = null;
    }
    persist();
    imageDbPutJob(job);
    updateSidebar();
    renderImageWorkspace();
    startImageProgressTimer();
    let timeoutId = null;

    try {
      timeoutId = setTimeout(() => controller.abort(), imageTimeoutMs(params));
      job.outputs = state.imageMapModel
        ? await requestMappedImage(prompt, params, job.inputImage, controller.signal)
        : job.inputImage
          ? await requestImageEdit(prompt, params, job.inputImage, controller.signal)
          : await requestOneImage(prompt, params, controller.signal);
      if (job.outputs.length === 0) throw new Error('接口未返回可显示的图片数据');
      job.error = null;
      job.status = 'done';
      job.durationMs = Date.now() - startedAt;
      if (!retryJob && ref) {
        state.imageRef = null;
        renderImageRefPreview();
      }
      showToast('图片已生成');
    } catch (e) {
      const aborted = e?.name === 'AbortError';
      job.error = aborted ? '请求已中断。可能是手动取消、页面刷新或等待超时，请重试。' : `${e.message}${e.diagnostics ? `\n\n${e.diagnostics}` : ''}`;
      job.status = aborted ? 'cancelled' : 'error';
      job.durationMs = Date.now() - startedAt;
      showToast(aborted ? '生成已中断' : '生成失败');
    } finally {
      state.isGeneratingImage = false;
      state.imageAbortController = null;
      stopImageProgressTimer();
      if (timeoutId) clearTimeout(timeoutId);
      if (job.status === 'generating') job.status = 'done';
      persist();
      imageDbPutJob(job);
      updateSidebar();
      renderImageWorkspace();
      updateImageGenerateBtn();
    }
  }

  // ===== Event Binding =====
  // Sidebar
  dom.sidebarToggle.addEventListener('click', toggleSidebar);
  dom.sidebarBackdrop.addEventListener('click', closeSidebarMobile);
  dom.sidebarSearch.addEventListener('input', () => {
    state.sidebarSearch = dom.sidebarSearch.value;
    updateSidebar();
  });
  dom.modeChatBtn.addEventListener('click', () => {
    switchMode('chat');
  });
  dom.modeImageBtn.addEventListener('click', () => switchMode('image'));
  dom.newChatBtn.addEventListener('click', () => {
    if (state.mode === 'image') {
      state.currentImageJobId = null;
      dom.imagePrompt.value = '';
      persist();
      updateSidebar();
      renderImageWorkspace();
      closeSidebarMobile();
      dom.imagePrompt.focus();
      return;
    }
    newConv();
    updateSidebar();
    renderMessages();
    closeSidebarMobile();
    syncConvParams();
    dom.userInput.focus();
  });

  // Sync params to/from current conversation
  function syncConvParams() {
    const conv = currentConv();
    if (conv) {
      dom.paramTemperature.value = conv.temperature;
      dom.paramTopP.value = conv.topP;
      dom.paramMaxTokens.value = conv.maxTokens;
      dom.convRenameInput.value = conv.title;
      dom.convRoleInput.value = conv.systemPrompt || '';
    }
  }

  function saveConvParams() {
    const conv = currentConv();
    if (!conv) return;
    conv.temperature = parseFloat(dom.paramTemperature.value) || 0.7;
    conv.topP = parseFloat(dom.paramTopP.value) || 1;
    conv.maxTokens = parseInt(dom.paramMaxTokens.value) || 4096;
    conv.systemPrompt = dom.convRoleInput.value.trim();
    const newName = dom.convRenameInput.value.trim();
    if (newName) conv.title = newName;
    persist();
    updateSidebar();
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
  dom.imageSettingsBtn.addEventListener('click', toggleImageSettings);
  dom.paramTemperature.addEventListener('change', saveConvParams);
  dom.paramTopP.addEventListener('change', saveConvParams);
  dom.paramMaxTokens.addEventListener('change', saveConvParams);
  dom.convRenameInput.addEventListener('change', saveConvParams);
  dom.convRoleInput.addEventListener('change', saveConvParams);
  dom.convRoleInput.addEventListener('blur', saveConvParams);

  // Conversation list
  dom.convList.addEventListener('click', (e) => {
    if (state.mode === 'image') {
      const delBtn = e.target.closest('.conv-item-delete');
      if (delBtn) {
        const item = delBtn.closest('.conv-item');
        const id = item.dataset.id;
        state.imageJobs = state.imageJobs.filter(j => j.id !== id);
        if (state.currentImageJobId === id) state.currentImageJobId = state.imageJobs[0]?.id || null;
        persist();
        imageDbDeleteJob(id);
        updateSidebar();
        renderImageWorkspace();
        return;
      }
      const item = e.target.closest('.conv-item');
      if (item) {
        state.currentImageJobId = item.dataset.id;
        persist();
        updateSidebar();
        renderImageWorkspace();
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
      const titleEl = item.querySelector('.conv-item-title');
      const currentTitle = conv.title;
      titleEl.innerHTML = `<input class="conv-rename-input" type="text" value="${esc(currentTitle)}" maxlength="50">`;
      const input = titleEl.querySelector('.conv-rename-input');
      input.focus();
      input.select();
      const finishRename = () => {
        const newTitle = input.value.trim() || currentTitle;
        conv.title = newTitle;
        persist();
        updateSidebar();
        if (id === state.currentConvId) renderMessages();
      };
      input.addEventListener('blur', finishRename);
      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
        if (ke.key === 'Escape') { input.value = currentTitle; input.blur(); }
      });
      return;
    }

    const delBtn = e.target.closest('.conv-item-delete');
    if (delBtn) {
      const item = delBtn.closest('.conv-item');
      const id = item.dataset.id;
      state.conversations = state.conversations.filter(c => c.id !== id);
      if (state.currentConvId === id) {
        state.currentConvId = state.conversations[0]?.id || null;
      }
      persist();
      updateSidebar();
      renderMessages();
      return;
    }

    const item = e.target.closest('.conv-item');
    if (item) {
      state.currentConvId = item.dataset.id;
      persist();
      updateSidebar();
      renderMessages();
      syncConvParams();
      closeSidebarMobile();
    }
  });

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

  dom.cfgRefreshModels.addEventListener('click', () => {
    refreshModelsForSelect(dom.cfgBaseUrl.value.trim(), dom.cfgApiKey.value.trim(), dom.cfgModelSelect, dom.cfgRefreshModels);
  });

  dom.cfgRefreshImageModels.addEventListener('click', async () => {
    await refreshModelsForSelect(dom.cfgImageBaseUrl.value.trim(), dom.cfgImageApiKey.value.trim(), dom.cfgImageModelSelect, dom.cfgRefreshImageModels, { image: true });
    populateImageMapModelSelect();
    populateImagePromptModelSelect();
    dom.cfgImageMapModelSelect.value = state.imageMapModel;
    dom.cfgImagePromptModelSelect.value = state.imagePromptModel;
  });

  dom.cfgExportSafe.addEventListener('click', () => {
    downloadJson(`ownchat-config-${Date.now()}.json`, appConfigSnapshot(false));
  });
  dom.cfgExportFull.addEventListener('click', () => {
    if (!confirm('含密钥导出会把 API Key 写入 JSON 文件。确认继续？')) return;
    downloadJson(`ownchat-config-with-keys-${Date.now()}.json`, appConfigSnapshot(true));
  });
  dom.cfgImportFile.addEventListener('click', () => dom.cfgImportInput.click());
  dom.cfgImportInput.addEventListener('change', () => {
    const file = dom.cfgImportInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        showConfigImportConfirm(parseImportConfig(String(reader.result || '')));
      } catch (e) {
        alert(`导入配置失败: ${e.message}`);
      }
    };
    reader.readAsText(file);
    dom.cfgImportInput.value = '';
  });

  dom.imageHistoryStats.addEventListener('click', updateImageHistorySummary);
  dom.imageHistoryTrim.addEventListener('click', () => trimImageHistory(20));
  dom.imageHistoryClear.addEventListener('click', clearImageHistory);

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

  dom.cfgSave.addEventListener('click', () => {
    const savingImageTab = dom.settingsImageTab.classList.contains('active');
    const b = dom.cfgBaseUrl.value.trim();
    const k = dom.cfgApiKey.value.trim();
    const m = dom.cfgModelManual.value.trim() || dom.cfgModelSelect.value;
    const ib = dom.cfgImageBaseUrl.value.trim();
    const ik = dom.cfgImageApiKey.value.trim();
    const im = dom.cfgImageModelManual.value.trim() || dom.cfgImageModelSelect.value;
    const imm = dom.cfgImageMapModelManual.value.trim();
    const mapModel = imm || dom.cfgImageMapModelSelect.value;
    const ipm = dom.cfgImagePromptModelManual.value.trim();
    const promptModel = ipm || dom.cfgImagePromptModelSelect.value;

    const needChat = !savingImageTab;
    const needImage = savingImageTab;

    if (needChat && (!b || !k || !m)) { alert('请填写对话配置项并选择模型'); return; }
    if (needImage && (!ib || !ik || !im)) { alert('请填写绘画配置项并选择模型'); return; }

    if (needChat || b || k || dom.cfgModelManual.value.trim()) {
      if (!b || !k || !m) { alert('对话配置需要同时填写 Base URL、API Key 和模型'); return; }
      state.baseUrl = b;
      state.apiKey = k;
      state.model = m;
      state.modelsCache = mergeUnique([m], state.modelsCache);
    }
    if (needImage || ib || ik || dom.cfgImageModelManual.value.trim()) {
      if (!ib || !ik || !im) { alert('绘画配置需要同时填写 Base URL、API Key 和模型'); return; }
      state.imageBaseUrl = ib;
      state.imageApiKey = ik;
      state.imageModel = im;
      state.imageMapModel = mapModel || '';
      state.imagePromptModel = promptModel || '';
      state.imageModelsCache = mergeUnique([im, mapModel, promptModel], state.imageModelsCache, DEFAULT_IMAGE_MODELS);
    }
    persist();
    updateModelBadge();
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
    state.baseUrl = b;
    state.apiKey = k;
    state.model = m;
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
    if (opt.dataset.clearMap) {
      state.imageMapModel = '';
      persist();
      updateModelBadge();
      closeModelDropdown();
      updateImageGenerateBtn();
      showToast('已关闭映射模型');
      return;
    }
    if (state.mode === 'image') {
      if (state.imageMapModel) state.imageMapModel = opt.dataset.model;
      else state.imageModel = opt.dataset.model;
    }
    else state.model = opt.dataset.model;
    persist();
    updateModelBadge();
    closeModelDropdown();
    updateSendBtn();
    updateImageGenerateBtn();
    showToast(`已切换到 ${state.mode === 'image' ? state.imageModel : state.model}`);
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
    const thinkingToggle = e.target.closest('.thinking-toggle');
    if (thinkingToggle) {
      thinkingToggle.closest('.thinking-block').classList.toggle('expanded');
      return;
    }

    const codeCopyBtn = e.target.closest('.code-copy-btn');
    if (codeCopyBtn) {
      const codeBlock = codeCopyBtn.closest('.code-block');
      const code = codeBlock.querySelector('code')?.textContent || '';
      copyText(code);
      codeCopyBtn.classList.add('copied');
      setTimeout(() => codeCopyBtn.classList.remove('copied'), 1500);
      return;
    }

    const btn = e.target.closest('.msg-action-btn');
    if (!btn) return;
    const conv = currentConv();
    if (!conv) return;
    const idx = parseInt(btn.dataset.idx);
    const msg = conv.messages[idx];
    if (!msg) return;

    if (btn.dataset.action === 'copy') {
      copyText(copyableMessageText(msg));
    } else if (btn.dataset.action === 'retry') {
      retryMessage(idx);
    } else if (btn.dataset.action === 'edit') {
      const text = messageTextContent(msg);
      dom.userInput.value = text;
      dom.userInput.focus();
      autoResize();
    }
  });

  // Welcome tip cards
  dom.welcome.addEventListener('click', (e) => {
    const card = e.target.closest('.tip-card');
    if (!card) return;
    dom.userInput.value = card.dataset.prompt;
    autoResize();
    updateSendBtn();
    dom.userInput.focus();
  });

  // File upload
  dom.attachBtn.addEventListener('click', () => { dom.fileInput.click(); });

  dom.fileInput.addEventListener('change', () => {
    for (const file of dom.fileInput.files) {
      if (state.pendingFiles.find(f => f.name === file.name && f.size === file.size)) continue;
      const entry = { name: file.name, size: file.size, type: file.type };
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          entry.base64 = ev.target.result;
          state.pendingFiles.push(entry);
          renderFilePreview();
        };
        reader.readAsDataURL(file);
      } else {
        const reader = new FileReader();
        reader.onload = (ev) => {
          entry.text = ev.target.result;
          state.pendingFiles.push(entry);
          renderFilePreview();
        };
        reader.readAsText(file);
      }
    }
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
      const inner = f.base64
        ? `<img src="${f.base64}" class="file-thumb">`
        : `<div class="file-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>`;
      return `<div class="file-preview-item" data-index="${i}">${inner}<span class="file-name">${esc(f.name)}</span><button class="file-remove" data-index="${i}" type="button">&times;</button></div>`;
    }).join('');
  }

  dom.filePreview.addEventListener('click', (e) => {
    const btn = e.target.closest('.file-remove');
    if (!btn) return;
    const idx = parseInt(btn.dataset.index);
    state.pendingFiles.splice(idx, 1);
    renderFilePreview();
  });

  dom.imagePrompt.addEventListener('input', updateImageGenerateBtn);
  dom.imageRefBtn.addEventListener('click', () => dom.imageRefInput.click());
  dom.imageOptimizeBtn.addEventListener('click', optimizeImagePrompt);
  dom.imageRefInput.addEventListener('change', () => {
    const file = dom.imageRefInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      state.imageRef = { name: file.name, type: file.type, base64: ev.target.result };
      renderImageRefPreview();
      updateImageGenerateBtn();
    };
    reader.readAsDataURL(file);
    dom.imageRefInput.value = '';
  });
  dom.imageRefPreview.addEventListener('click', (e) => {
    if (!e.target.closest('.image-ref-remove')) return;
    state.imageRef = null;
    renderImageRefPreview();
    updateImageGenerateBtn();
  });
  [dom.imageSize, dom.imageQuality, dom.imageFormat, dom.imageBackground].forEach(el => {
    el.addEventListener('change', () => {
      saveImageParams();
      updateImageGenerateBtn();
    });
  });
  dom.imageGenerateBtn.addEventListener('click', () => {
    saveImageParams();
    const prompt = dom.imagePrompt.value.trim();
    if (!ensureModeConfigured('image')) return;
    if (!prompt) return;
    generateImage(prompt);
  });
  dom.imagePrompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      dom.imageGenerateBtn.click();
    }
  });
  dom.imageGallery.addEventListener('click', (e) => {
    const preview = e.target.closest('.image-preview');
    if (preview) {
      const result = preview.closest('.image-result');
      const job = state.imageJobs.find(j => j.id === result.dataset.job);
      const out = job?.outputs?.[parseInt(result.dataset.index, 10)];
      if (job && out) openImageViewer(job, out);
      return;
    }

    const btn = e.target.closest('.image-action');
    if (!btn) return;
    const job = state.imageJobs.find(j => j.id === btn.dataset.job);
    if (!job) return;
    if (btn.dataset.action === 'reuse') {
      dom.imagePrompt.value = job.prompt;
      state.currentImageJobId = job.id;
      state.imageDefaults = Object.assign({}, DEFAULT_IMAGE_PARAMS, job.params || {});
      syncImageParams();
      updateImageGenerateBtn();
      persist();
      updateSidebar();
      dom.imagePrompt.focus();
    } else if (btn.dataset.action === 'retry') {
      if (job.status === 'generating') return;
      state.currentImageJobId = job.id;
      generateImage(job.prompt, job.params || state.imageDefaults, job);
    } else if (btn.dataset.action === 'cancel') {
      cancelImageGeneration();
    } else if (btn.dataset.action === 'view') {
      const out = job.outputs[parseInt(btn.dataset.index, 10)];
      if (out) openImageViewer(job, out);
    } else if (btn.dataset.action === 'use-as-ref') {
      const out = job.outputs[parseInt(btn.dataset.index, 10)];
      if (!out) return;
      if (!out.b64) {
        showToast('链接图片无法直接作为参考图，请先下载后上传');
        return;
      }
      state.imageRef = {
        name: imageFilename(job, out),
        type: `image/${out.format || job.params?.outputFormat || 'png'}`,
        base64: dataUrlForImage(out, job.params?.outputFormat),
      };
      dom.imagePrompt.value = job.prompt;
      state.currentImageJobId = null;
      renderImageRefPreview();
      updateImageGenerateBtn();
      persist();
      updateSidebar();
      renderImageWorkspace();
      dom.imagePrompt.focus();
    } else if (btn.dataset.action === 'copy-image') {
      const out = job.outputs[parseInt(btn.dataset.index, 10)];
      if (out) copyImage(job, out);
    } else if (btn.dataset.action === 'download') {
      const out = job.outputs[parseInt(btn.dataset.index, 10)];
      if (!out) return;
      downloadImage(job, out);
    }
  });
  dom.imageGallery.addEventListener('load', (e) => {
    const img = e.target.closest?.('.image-preview');
    if (!img) return;
    const result = img.closest('.image-result');
    if (!result) return;
    updateImageOutputMeta(result.dataset.job, parseInt(result.dataset.index, 10), img);
  }, true);

  dom.imageViewerClose.addEventListener('click', closeImageViewer);
  dom.imageViewer.querySelector('.image-viewer-backdrop').addEventListener('click', closeImageViewer);
  dom.imageViewerImg.addEventListener('wheel', zoomImageViewer, { passive: false });
  dom.imageViewerImg.addEventListener('pointerdown', startImageViewerDrag);
  dom.imageViewer.addEventListener('pointermove', moveImageViewerDrag);
  dom.imageViewer.addEventListener('pointerup', endImageViewerDrag);
  dom.imageViewer.addEventListener('pointercancel', endImageViewerDrag);
  dom.imageViewerImg.addEventListener('contextmenu', e => e.preventDefault());
  dom.imageViewerImg.addEventListener('dblclick', resetImageViewerTransform);
  dom.imageViewerImg.addEventListener('touchstart', startImageViewerTouch, { passive: false });
  dom.imageViewerImg.addEventListener('touchmove', moveImageViewerTouch, { passive: false });
  dom.imageViewerImg.addEventListener('touchend', endImageViewerTouch);
  dom.imageViewerImg.addEventListener('touchcancel', endImageViewerTouch);
  dom.imageViewerCopy.addEventListener('click', () => {
    const current = currentViewerImage();
    if (current) copyImage(current.job, current.out);
  });
  dom.imageViewerDownload.addEventListener('click', () => {
    const current = currentViewerImage();
    if (current) downloadImage(current.job, current.out);
  });

  window.addEventListener('beforeunload', (e) => {
    if (!state.isGeneratingImage) return;
    e.preventDefault();
    e.returnValue = '图片正在生成，刷新或关闭页面会中断当前请求。';
  });

  // Send
  dom.sendBtn.addEventListener('click', () => {
    if (state.isStreaming) {
      state.chatAbortController?.abort();
      return;
    }
    const text = dom.userInput.value.trim();
    if (!ensureModeConfigured('chat')) return;
    if (!text || state.isStreaming) return;
    if (!currentConv()) { newConv(); updateSidebar(); syncConvParams(); }
    dom.userInput.value = '';
    autoResize();
    sendMsg(text);
  });

  dom.userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      dom.sendBtn.click();
    }
  });

  dom.userInput.addEventListener('input', () => {
    autoResize();
    updateSendBtn();
  });

  // ===== Init =====
  applyTheme();

  // On mobile, start with sidebar collapsed
  if (isMobile()) {
    state.sidebarCollapsed = true;
    dom.sidebar.classList.add('collapsed');
    dom.sidebarBackdrop.classList.add('hidden');
  } else {
    dom.sidebar.classList.toggle('collapsed', state.sidebarCollapsed);
  }
  updateModelBadge();
  updateSidebar();
  updateSendBtn();
  syncImageParams();
  updateImageGenerateBtn();
  importConfigFromUrl();

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
  loadImageHistory();
})();
