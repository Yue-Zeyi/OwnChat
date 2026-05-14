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
    showThinking: 'nc_show_thinking',
    includeContext: 'nc_include_context',
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
    mdParser.renderer.rules.fence = (tokens, idx, options, env, self) => {
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

    // Extract fenced code blocks first to protect their content
    const codeBlocks = [];
    let html = raw.replace(/```([\w#+.\-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      const highlighted = highlightCode(code.trimEnd(), lang);
      codeBlocks.push(`<div class="code-block">${codeHeader(lang)}<pre><code>${highlighted}</code></pre></div>`);
      return `\x00CODE${idx}\x00`;
    });
    // Also support tilde-fenced code blocks (~~~)
    html = html.replace(/~~~([\w#+.\-]*)\n([\s\S]*?)~~~/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      const highlighted = highlightCode(code.trimEnd(), lang);
      codeBlocks.push(`<div class="code-block">${codeHeader(lang)}<pre><code>${highlighted}</code></pre></div>`);
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
    html = html.replace(/^###### (.+)$/gm, (_, t) => `<h6>${renderInline(t)}</h6>`);
    html = html.replace(/^##### (.+)$/gm, (_, t) => `<h5>${renderInline(t)}</h5>`);
    html = html.replace(/^#### (.+)$/gm, (_, t) => `<h4>${renderInline(t)}</h4>`);
    html = html.replace(/^### (.+)$/gm, (_, t) => `<h3>${renderInline(t)}</h3>`);
    html = html.replace(/^## (.+)$/gm, (_, t) => `<h2>${renderInline(t)}</h2>`);
    html = html.replace(/^# (.+)$/gm, (_, t) => `<h1>${renderInline(t)}</h1>`);

    // Horizontal rules — support -, *, _ with optional spaces between
    html = html.replace(/^[-*_](?:\s*[-*_]){2,}\s*$/gm, '<hr>');

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

    // Paragraphs — split by double newline; single newlines are soft breaks
    html = html.split(/\n{2,}/).map(p => {
      p = p.trim();
      if (!p) return '';
      if (/^<(div|pre|table|h[1-6]|ul|ol|blockquote|hr|p)/.test(p)) return p;
      if (p.startsWith('\x00CODE')) return p;
      // Soft line breaks: single \n → space (CommonMark behavior)
      // Hard line breaks: two trailing spaces or trailing \ → <br>
      p = p.replace(/  \n|\n/g, (m, offset, str) => {
        // Check for trailing \ before newline
        if (offset > 0 && str[offset - 1] === '\\') return '<br>';
        return m === '  \n' ? '<br>' : ' ';
      });
      return `<p>${renderInline(p)}</p>`;
    }).join('\n');

    // Restore code blocks
    html = html.replace(/\x00CODE(\d+)\x00/g, (_, idx) => codeBlocks[idx]);
    // Restore inline codes
    html = html.replace(/\x00ICODE(\d+)\x00/g, (_, idx) => inlineCodes[idx]);

    return html;
  }

  // Inline rendering (links/images before emphasis, protected by placeholders)
  // Note: `text` is already HTML-entity-encoded (via esc()). We need to unescape
  // before splicing into HTML tags so the browser renders special chars correctly.
  function renderInline(text) {
    const inlineParts = [];
    const stash = html => {
      const idx = inlineParts.length;
      inlineParts.push(html);
      return `\x00PART${idx}\x00`;
    };

    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      const safeUrl = sanitizeUrl(url, { image: true });
      return stash(`<img src="${safeUrl}" alt="${esc(unesc(stripMd(alt)))}" loading="lazy">`);
    });
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const safeUrl = sanitizeUrl(url);
      return stash(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${esc(unesc(stripMd(label)))}</a>`);
    });
    text = text.replace(/&lt;code&gt;([\s\S]*?)&lt;\/code&gt;/g, (_, code) => stash(`<code>${esc(code)}</code>`));
    // Unescape before wrapping in HTML tags so entities render correctly
    text = text.replace(/~~(.+?)~~/g, (_, c) => `<del>${unesc(c)}</del>`);
    text = text.replace(/\*\*([^\n*](?:[^\n]*?[^\n*])?)\*\*/g, (_, c) => `<strong>${unesc(c)}</strong>`);
    // Italic: avoid lookbehind for broader browser compatibility.
    text = text.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, (_, pre, c) => `${pre}<em>${unesc(c)}</em>`);
    text = text.replace(/\*\*([^*\n]{1,80})$/g, (_, c) => unesc(c));
    text = text.replace(/(^|[\s([])\*([^\s*\n][^*\n]{0,79})$/g, (_, pre, c) => `${pre}${unesc(c)}`);
    // Autolinks: bare URLs become clickable
    text = text.replace(/(^|[^=&\x00])((?:https?:\/\/)[^\s<\x00]+[^\s<\x00.,;:!?)'"`\]}])/gim, (_, pre, url) => {
      return `${pre}${stash(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`)}`;
    });
    text = text.replace(/\x00PART(\d+)\x00/g, (_, idx) => inlineParts[idx]);
    return text;
  }

  function unesc(t) { return t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }

  function esc(t) { return t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  function stripMd(t) {
    return t.replace(/[*_~`[\]]/g, '');
  }

  function sanitizeUrl(rawUrl, opts = {}) {
    return esc(sanitizeUrlValue(rawUrl, opts));
  }

  function sanitizeUrlValue(rawUrl, opts = {}) {
    const url = rawUrl.trim().replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
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
    // Collect all highlight regions first, then build output in one pass
    const regions = [];
    const add = (start, end, cls) => regions.push({ start, end, cls });

    // Collect string regions first (strings take priority over comments)
    const stringRegions = [];
    for (const m of code.matchAll(/"(?:[^"\\]|\\.)*"/g)) { add(m.index, m.index + m[0].length, 'hl-string'); stringRegions.push([m.index, m.index + m[0].length]); }
    for (const m of code.matchAll(/'(?:[^'\\]|\\.)*'/g)) { add(m.index, m.index + m[0].length, 'hl-string'); stringRegions.push([m.index, m.index + m[0].length]); }

    const inString = idx => stringRegions.some(([s, e]) => idx >= s && idx < e);

    // Comments — skip if inside a string
    for (const m of code.matchAll(/\/\*[\s\S]*?\*\//g)) {
      if (!inString(m.index)) add(m.index, m.index + m[0].length, 'hl-comment');
    }
    for (const m of code.matchAll(/\/\/.*$/gm)) {
      if (!inString(m.index)) add(m.index, m.index + m[0].length, 'hl-comment');
    }
    if (/^(py|python|rb|ruby|sh|bash|yaml|yml|toml|r|perl|pl)/i.test(lang)) {
      for (const m of code.matchAll(/#.*$/gm)) {
        if (!inString(m.index)) add(m.index, m.index + m[0].length, 'hl-comment');
      }
    }
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
  let serviceWorkerRegistrationPromise = null;

  const state = {
    mode: load(KEYS.mode) || 'chat',
    baseUrl: load(KEYS.baseUrl) || '',
    apiKey: load(KEYS.apiKey) || '',
    model: load(KEYS.model) || '',
    modelsCache: load(KEYS.modelsCache) || [],
    conversations: load(KEYS.conversations) || [],
    currentConvId: load(KEYS.currentConvId) || null,
    tokenStats: load(KEYS.tokenStats) || { input: 0, output: 0, total: 0 },
    showThinking: load(KEYS.showThinking) !== false,
    includeContext: load(KEYS.includeContext) !== false,
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
    viewerImage: null,
    imageViewerTransform: { scale: 1, x: 0, y: 0 },
    imageViewerDragging: null,
    imageViewerTouch: null,
    imageRef: null,
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
      [state.imageModel],
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
    if (configured() || imageConfigured()) {
      cleanConfigUrl();
      showToast('已存在本地配置，已忽略 URL 配置');
      return false;
    }
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

  function conversationShowThinking(conv = currentConv()) {
    return conv?.showThinking !== undefined ? conv.showThinking !== false : state.showThinking !== false;
  }

  function conversationIncludeContext(conv = currentConv()) {
    return conv?.includeContextDefault !== undefined ? conv.includeContextDefault !== false : true;
  }

  function newConv() {
    const conv = { id: Date.now().toString(), title: '新对话', messages: [], createdAt: Date.now(), temperature: 0.7, topP: 1, maxTokens: DEFAULT_MAX_TOKENS, contextLimit: DEFAULT_CONTEXT_LIMIT, systemPrompt: '', showThinking: state.showThinking !== false, includeContextDefault: true };
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

  function configured() { return state.baseUrl && state.apiKey && state.model; }
  function imageConfigured() { return effectiveImageBaseUrl() && effectiveImageApiKey() && state.imageModel; }
  function parseSourcedModelRef(value, fallback = 'image') {
    const raw = (value || '').trim();
    const match = raw.match(/^(chat|image):(.+)$/i);
    if (match) return { source: match[1].toLowerCase(), model: match[2].trim(), value: `${match[1].toLowerCase()}:${match[2].trim()}` };

    const hasImageModel = state.imageModelsCache.includes(raw) || DEFAULT_IMAGE_MODELS.includes(raw);
    const hasChatModel = state.modelsCache.includes(raw) || raw === state.model;
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

  const DEFAULT_CONTEXT_LIMIT = 128000;
  const DEFAULT_MAX_TOKENS = 128000;
  const TOKEN_K = 1000;

  function tokensToK(tokens, fallback) {
    const value = Number.isFinite(Number(tokens)) ? Number(tokens) : fallback;
    return Math.round(value / TOKEN_K);
  }

  function kToTokens(value, fallback, opts = {}) {
    const kValue = parseFloat(value);
    if (!Number.isFinite(kValue) || kValue < 0) return fallback;
    if (opts.allowZero && kValue === 0) return 0;
    return Math.max(TOKEN_K, Math.round(kValue * TOKEN_K));
  }

  function trimContextMessages(messages, systemPrompt, maxTokens) {
    if (maxTokens === 0) {
      // 0 means no trimming
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
    for (const m of allMessages) {
      totalTokens += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    }

    if (totalTokens <= maxTokens) return allMessages;

    // Trim from the front, always keep system prompt + last user/assistant pair
    const sysMsg = allMessages[0]?.role === 'system' ? allMessages[0] : null;
    const rest = sysMsg ? allMessages.slice(1) : allMessages;

    // Find the last user message index
    let lastUserIdx = -1;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (rest[i].role === 'user') { lastUserIdx = i; break; }
    }

    const keepTail = rest.slice(Math.max(0, lastUserIdx));
    const tailTokens = keepTail.reduce((s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);
    const sysTokens = sysMsg ? estimateTokens(sysMsg.content) : 0;
    const budget = maxTokens - sysTokens - tailTokens;

    const head = [];
    let headTokens = 0;
    for (const m of rest.slice(0, Math.max(0, lastUserIdx))) {
      const t = estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      if (headTokens + t > budget) break;
      head.push(m);
      headTokens += t;
    }

    const result = [];
    if (sysMsg) result.push(sysMsg);
    result.push(...head, ...keepTail);
    return result;
  }

  function apiMessagesTokenCount(messages) {
    return messages.reduce((sum, msg) => {
      return sum + estimateTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || ''));
    }, 0);
  }

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

  function formatShortDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
  }

  function usageInputTokens(usage, fallback) {
    const normalized = normalizeUsage(usage);
    return normalized?.input ?? fallback;
  }

  function usageOutputTokens(usage, fallback) {
    const normalized = normalizeUsage(usage);
    return normalized?.output ?? fallback;
  }

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

  function canUseServiceWorker() {
    return 'serviceWorker' in navigator && window.location.protocol !== 'file:';
  }

  function registerServiceWorker() {
    if (!canUseServiceWorker()) return Promise.resolve(null);
    if (!serviceWorkerRegistrationPromise) {
      serviceWorkerRegistrationPromise = navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(e => {
        console.warn('SW registration failed:', e);
        return null;
      });
    }
    return serviceWorkerRegistrationPromise;
  }

  async function ensureServiceWorkerTarget(timeoutMs = 5000) {
    if (!canUseServiceWorker()) return null;
    if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;

    const registration = await registerServiceWorker();
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

  // ===== IndexedDB for large image history & file attachments =====
  const IMAGE_DB = { name: 'ownchat_image_db', version: 3, store: 'jobs', fileStore: 'files' };
  let imageDbPromise = null;
  let imageDbWarned = false;

  function openImageDb() {
    if (imageDbPromise) return imageDbPromise;
    imageDbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(IMAGE_DB.name, IMAGE_DB.version);
      req.onupgradeneeded = () => {
        const db = req.result;
        // Ensure 'jobs' store exists (for upgrades from version 1)
        if (!db.objectStoreNames.contains(IMAGE_DB.store)) {
          const store = db.createObjectStore(IMAGE_DB.store, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
        // Ensure 'files' store exists (for upgrades from version 1 or 2)
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
      if (legacyJobs.length && !localStorage.getItem('nc_image_migrated')) {
        await Promise.allSettled(legacyJobs.map(imageDbPutJob));
        localStorage.removeItem('nc_image_jobs');
        localStorage.setItem('nc_image_migrated', '1');
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
      return sum + imageJobReplies(job).reduce((n, reply) => {
        return n + (reply.outputs || []).reduce((m, out) => m + imageByteSize(out), 0);
      }, 0);
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

  // ===== File Attachment IndexedDB helpers =====
  async function fileDbPut(fileData) {
    try {
      const db = await openImageDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IMAGE_DB.fileStore, 'readwrite');
        tx.objectStore(IMAGE_DB.fileStore).put(fileData);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      return true;
    } catch (e) {
      console.warn('File attachment save failed:', e);
      return false;
    }
  }

  async function fileDbGet(id) {
    try {
      const db = await openImageDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IMAGE_DB.fileStore, 'readonly');
        const req = tx.objectStore(IMAGE_DB.fileStore).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('File attachment load failed:', e);
      return null;
    }
  }

  async function fileDbGetAll() {
    try {
      const db = await openImageDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IMAGE_DB.fileStore, 'readonly');
        const req = tx.objectStore(IMAGE_DB.fileStore).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('File attachments load failed:', e);
      return [];
    }
  }

  async function fileDbDelete(id) {
    try {
      const db = await openImageDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IMAGE_DB.fileStore, 'readwrite');
        tx.objectStore(IMAGE_DB.fileStore).delete(id);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('File attachment delete failed:', e);
    }
  }

  function collectConversationFileIds(conversations) {
    const ids = new Set();
    for (const conv of conversations || []) {
      if (!conv) continue;
      for (const msg of conv.messages || []) {
        if (Array.isArray(msg.files)) {
          msg.files.forEach(f => { if (f?.fileId) ids.add(f.fileId); });
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

  function generateFileId(convId, msgIndex, partIndex) {
    return `${convId}_${msgIndex}_${partIndex}`;
  }

  function isFileReady(file) {
    return !!(file && !file.loading && (file.base64 || typeof file.text === 'string'));
  }

  function hasPendingFileReads() {
    return state.pendingFiles.some(f => f.loading || !isFileReady(f));
  }

  // ===== Stream Session IndexedDB (shared with Service Worker) =====
  const STREAM_KEY = 'active_stream';
  const IMAGE_KEY = 'active_image';
  const STREAM_DB_NAME = 'ownchat_stream_db';
  const STREAM_DB_VERSION = 2;
  const STREAM_STORE = 'sessions';
  let streamDbPromise = null;

  function openStreamDb() {
    if (streamDbPromise) return streamDbPromise;
    streamDbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
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
      await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    } catch { /* ignore */ }
  }

  async function getStreamSession() {
    try {
      const db = await openStreamDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STREAM_STORE, 'readonly');
        const req = tx.objectStore(STREAM_STORE).get(STREAM_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch { return null; }
  }

  async function getStableStreamSession(baseSession) {
    if (!baseSession || !['complete', 'error', 'stopped'].includes(baseSession.status)) return baseSession;
    await new Promise(r => setTimeout(r, 50));
    const latest = await getStreamSession();
    if (!latest || (latest.convId && baseSession.convId && latest.convId !== baseSession.convId)) return baseSession;
    return Object.assign({}, baseSession, latest);
  }

  async function clearStreamSession() {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readwrite');
      tx.objectStore(STREAM_STORE).delete(STREAM_KEY);
      await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    } catch { /* ignore */ }
  }

  async function getImageSession() {
    try {
      const db = await openStreamDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STREAM_STORE, 'readonly');
        const req = tx.objectStore(STREAM_STORE).get(IMAGE_KEY);
        req.onsuccess = () => resolve(normalizeImageSession(req.result || null));
        req.onerror = () => reject(req.error);
      });
    } catch { return null; }
  }

  function normalizeImageSession(session) {
    if (!session) return null;
    if ((session.status === 'connecting' || session.status === 'streaming')) {
      if (typeof session.outputs === 'string' && session.outputs.trim()) {
        return Object.assign({}, session, { status: 'complete' });
      }
      if (session.error) {
        return Object.assign({}, session, { status: 'error' });
      }
    }
    return session;
  }

  async function clearImageSession() {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readwrite');
      tx.objectStore(STREAM_STORE).delete(IMAGE_KEY);
      await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    } catch { /* ignore */ }
  }

  async function clearImageSessionForJob(jobId, statuses = []) {
    try {
      const session = await getImageSession();
      if (!session || session.jobId !== jobId) return;
      if (statuses.length && !statuses.includes(session.status)) return;
      await clearImageSession();
    } catch { /* ignore */ }
  }

  async function writeImageSession(meta) {
    try {
      const db = await openStreamDb();
      const tx = db.transaction(STREAM_STORE, 'readwrite');
      tx.objectStore(STREAM_STORE).put(Object.assign({ id: IMAGE_KEY, status: 'stopped', updatedAt: Date.now() }, meta));
      await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    } catch { /* ignore */ }
  }

  // Strip base64 from messages for localStorage, store in IndexedDB instead
  function stripFilesFromConversations(conversations) {
    const fileMap = [];
    const queuedFileIds = new Set();
    const queueFile = fileData => {
      if (!fileData?.id || queuedFileIds.has(fileData.id)) return;
      queuedFileIds.add(fileData.id);
      fileMap.push(fileData);
    };
    const stripped = conversations.map(conv => {
      const strippedConv = Object.assign({}, conv);
      strippedConv.messages = conv.messages.map((msg, msgIdx) => {
        const imageFileIds = [];
        let changed = false;
        const strippedMsg = Object.assign({}, msg);
        if (msg.files && msg.files.length) {
          strippedMsg.files = msg.files.map((f, fIdx) => {
            const fileId = f.fileId || generateFileId(conv.id, msgIdx, fIdx);
            if (f.base64) {
              queueFile({ id: fileId, base64: f.base64, name: f.name, type: f.type });
              imageFileIds.push(fileId);
              changed = true;
              return { name: f.name, type: f.type, fileId: fileId };
            }
            if (f.fileId) imageFileIds.push(f.fileId);
            return f;
          });
        }
        if (Array.isArray(msg.content)) {
          let imageIdx = 0;
          strippedMsg.content = msg.content.map((part, partIdx) => {
            if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
              const fileId = part.image_url.fileId || imageFileIds[imageIdx] || generateFileId(conv.id, msgIdx, partIdx);
              imageIdx += 1;
              queueFile({ id: fileId, base64: part.image_url.url, name: '', type: 'image_url' });
              changed = true;
              return Object.assign({}, part, { image_url: { url: fileId, fileId: fileId } });
            }
            if (part.type === 'image_url' && part.image_url?.fileId) imageIdx += 1;
            return part;
          });
        }
        return changed ? strippedMsg : msg;
      });
      return strippedConv;
    });
    return { stripped, fileMap };
  }

  // Hydrate base64 data back into messages from IndexedDB
  async function hydrateFilesInConversations(conversations) {
    const allFiles = await fileDbGetAll();
    const fileById = new Map(allFiles.map(f => [f.id, f]));
    for (const conv of conversations) {
      for (const msg of conv.messages) {
        if (msg.files && msg.files.length) {
          for (const f of msg.files) {
            if (f.fileId) {
              const stored = fileById.get(f.fileId);
              if (stored) {
                f.base64 = stored.base64;
                delete f.missing;
              } else {
                f.missing = true;
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
          }
        }
      }
    }
    return conversations;
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

  // ===== Stream Render Throttle =====
  let streamRafPending = false;
  let streamRafCallback = null;

  function scheduleStreamRender(callback) {
    streamRafCallback = callback;
    if (streamRafPending) return;
    streamRafPending = true;
    requestAnimationFrame(() => {
      streamRafPending = false;
      if (streamRafCallback) {
        streamRafCallback();
        streamRafCallback = null;
      }
    });
  }

  // ===== Render Functions =====
  function updateModelBadge() {
    dom.currentModel.textContent = state.mode === 'image'
      ? (state.imageMapModel ? `映射 ${formatSourcedModel(state.imageMapModel)}` : (state.imageModel || '未配置'))
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

  function sidebarBulkCheckbox(id, label) {
    if (!state.sidebarBulkMode) return '';
    const checked = state.sidebarSelectedIds.has(id) ? ' checked' : '';
    return `<label class="conv-item-check" title="选择${esc(label)}">
      <input type="checkbox" data-action="bulk-check" data-id="${esc(id)}"${checked}>
      <span></span>
    </label>`;
  }

  function updateSidebarBulkBar() {
    const total = state.sidebarVisibleIds.length;
    const selected = state.sidebarVisibleIds.filter(id => state.sidebarSelectedIds.has(id)).length;
    dom.sidebarBulkBar.classList.toggle('is-active', state.sidebarBulkMode);
    dom.sidebarBulkToggle.classList.toggle('hidden', state.sidebarBulkMode);
    dom.sidebarBulkSelectAll.classList.toggle('hidden', !state.sidebarBulkMode);
    dom.sidebarBulkDelete.classList.toggle('hidden', !state.sidebarBulkMode);
    dom.sidebarBulkCancel.classList.toggle('hidden', !state.sidebarBulkMode);
    dom.sidebarBulkSelectAll.disabled = total === 0;
    dom.sidebarBulkSelectAll.textContent = total > 0 && selected === total ? '取消全选' : '全选';
    dom.sidebarBulkDelete.disabled = selected === 0;
    dom.sidebarBulkDelete.textContent = selected ? `删除 ${selected}` : '删除';
  }

  function updateSidebar() {
    if (state.mode === 'image') {
      dom.sidebarSearch.placeholder = '搜索绘画...';
      dom.newChatBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="M21 15l-5-5L5 21"/>
        </svg>
        新绘画
      `;
      if (state.isImageHistoryLoading) {
        dom.convList.innerHTML = `<div class="sidebar-empty">正在加载绘画历史...</div>`;
        return;
      }
      const q = state.sidebarSearch.trim().toLowerCase();
      const imageJobs = q
        ? state.imageJobs.filter(j => `${j.title || ''} ${j.prompt || ''} ${j.model || ''}`.toLowerCase().includes(q))
        : state.imageJobs;
      state.sidebarVisibleIds = imageJobs.map(j => j.id);
      state.sidebarSelectedIds = new Set([...state.sidebarSelectedIds].filter(id => state.sidebarVisibleIds.includes(id)));
      dom.convList.innerHTML = imageJobs.map(j => `
        <div class="conv-item ${j.id === state.currentImageJobId ? 'active' : ''} ${state.sidebarBulkMode ? 'bulk-mode' : ''}" data-id="${j.id}">
          ${sidebarBulkCheckbox(j.id, j.title || j.prompt || '绘画')}
          <span class="conv-item-title">${esc(j.title || j.prompt || '未命名绘画')}</span>
          <button class="conv-item-rename" type="button" title="重命名">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
          <button class="conv-item-delete" type="button" title="删除">&times;</button>
        </div>
      `).join('') || `<div class="sidebar-empty">没有匹配的绘画</div>`;
      updateSidebarBulkBar();
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
    state.sidebarVisibleIds = conversations.map(c => c.id);
    state.sidebarSelectedIds = new Set([...state.sidebarSelectedIds].filter(id => state.sidebarVisibleIds.includes(id)));
    dom.convList.innerHTML = conversations.map(c => `
      <div class="conv-item ${c.id === state.currentConvId ? 'active' : ''} ${state.sidebarBulkMode ? 'bulk-mode' : ''}" data-id="${c.id}">
        ${sidebarBulkCheckbox(c.id, c.title || '对话')}
        <span class="conv-item-title">${esc(c.title)}</span>
        <button class="conv-item-rename" type="button" title="重命名">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
        </button>
        <button class="conv-item-delete" type="button" title="删除">&times;</button>
      </div>
    `).join('') || `<div class="sidebar-empty">没有匹配的对话</div>`;
    updateSidebarBulkBar();
  }

  function updateSendBtn() {
    const hasText = !!dom.userInput.value.trim();
    const hasReadyFiles = state.pendingFiles.some(isFileReady);
    const hasLoadingFiles = hasPendingFileReads();
    dom.sendBtn.disabled = !state.isStreaming && (!configured() || hasLoadingFiles || (!hasText && !hasReadyFiles));
    dom.sendBtn.classList.toggle('is-stopping', state.isStreaming);
    const label = state.isStreaming ? '停止生成' : (hasLoadingFiles ? '附件读取中' : '发送');
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
    dom.imageGenerateBtn.title = state.imageRef ? '编辑图片' : '生成图片';
    dom.imageGenerateBtn.setAttribute('aria-label', state.imageRef ? '编辑图片' : '生成图片');
    dom.imageGenerateBtn.dataset.tooltip = state.imageRef ? '编辑图片' : '生成图片';
    dom.imageOptimizeBtn.disabled = !dom.imagePrompt.value.trim() || state.isOptimizingImagePrompt || state.isGeneratingImage;
    dom.imageOptimizeBtn.title = state.isOptimizingImagePrompt ? '正在优化提示词' : '优化提示词';
    dom.imageOptimizeBtn.setAttribute('aria-label', state.isOptimizingImagePrompt ? '正在优化提示词' : '优化提示词');
    dom.imageOptimizeBtn.dataset.tooltip = state.isOptimizingImagePrompt ? '正在优化提示词' : '优化提示词';
    dom.imageOptimizeBtn.classList.toggle('active', state.isOptimizingImagePrompt);
  }

  function formatTokenCount(n) {
    const value = Math.max(0, Math.round(n || 0));
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
    return String(value);
  }

  function currentConversationTokenTotals() {
    const conv = currentConv();
    const totals = { input: 0, output: 0, total: 0, count: 0 };
    if (!conv?.messages?.length) return totals;
    conv.messages.forEach(msg => {
      const usage = normalizeUsage(msg.usage);
      const tokens = msg.tokens || estimateTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || ''));
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
      resumeStreamPollIfNeeded();
      dom.userInput.focus();
    } else {
      syncImageParams();
      renderImageWorkspace();
      scrollImageWorkspaceToBottom(false);
      updateImageGenerateBtn();
      dom.imagePrompt.focus();
      recoverImageFromSession();
    }
    document.documentElement.removeAttribute('data-boot-mode');
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

  // ===== SVG Icons =====
  const SVG_PERSON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
  const SVG_COPY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const SVG_REFRESH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-8.36L23 10"/></svg>';
  const SVG_EDIT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  const SVG_DOWNLOAD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const SVG_MAXIMIZE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  const AI_AVATAR = '<div class="ai-avatar" aria-label="AI"></div>';

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

  function copyableMessagePlainText(msg) {
    const text = copyableMessageText(msg);
    if (!text) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = renderMd(text);
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

  function closeCopyMenus() {
    dom.messages?.querySelectorAll('.copy-menu.open').forEach(menu => menu.classList.remove('open'));
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
    const showThinking = conversationShowThinking(conv);

    dom.messages.innerHTML = conv.messages.map((msg, i) => {
      const isUser = msg.role === 'user';
      const avatar = isUser ? SVG_PERSON : AI_AVATAR;
      const splitContent = !isUser && typeof msg.content === 'string' ? splitThinkTags(msg.content) : null;
      const reasoningText = showThinking && !isUser ? (msg.reasoningContent || splitContent?.reasoning || '') : '';
      const mainContent = splitContent?.reasoning ? splitContent.content : msg.content;

      // Build content: thinking block + main content
      let contentHtml = '';
      if (!isUser && reasoningText) {
        const thinkingTimeStr = msg.reasoningTimeMs != null ? formatShortDuration(msg.reasoningTimeMs) : '';
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
            const fileMeta = Array.isArray(msg.files) ? msg.files.filter(f => f.base64 || f.fileId) : [];
            contentHtml += `<div class="msg-images">${imgParts.map((p, imgIdx) => {
              const file = fileMeta[imgIdx] || {};
              const name = file.name || `attachment-${imgIdx + 1}`;
              if (p.image_url.missing || file.missing) {
                return `<div class="msg-img-missing" title="${esc(name)}">附件已丢失</div>`;
              }
              return `<img src="${p.image_url.url}" class="msg-img" loading="lazy" data-action="view-attachment-image" data-name="${esc(name)}" alt="${esc(name)}">`;
            }).join('')}</div>`;
          }
        }
      } else {
        const mainText = typeof mainContent === 'string' ? mainContent : '';
        if (msg.streaming && !mainText.trim() && !reasoningText) {
          contentHtml += `
            <div class="stream-waiting">
              <span>正在思考</span>
              <div class="typing-dots"><span></span><span></span><span></span></div>
            </div>
          `;
        }
        contentHtml += `<div class="msg-md">${renderMd(mainText)}</div>`;
      }

      // Build meta row: timestamp + latency + tokens + model + actions
      const metaParts = [];
      if (isUser && msg.timestamp) {
        const d = new Date(msg.timestamp);
        const pad = n => String(n).padStart(2, '0');
        metaParts.push(`<span class="msg-meta-item">${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</span>`);
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
      const usage = normalizeUsage(msg.usage);
      if (usage && !isUser) {
        const usageParts = [];
        if (usage.input != null) usageParts.push(`输入 ${formatTokenCount(usage.input)}`);
        if (usage.output != null) usageParts.push(`输出 ${formatTokenCount(usage.output)}`);
        if (usage.total != null) usageParts.push(`总计 ${formatTokenCount(usage.total)}`);
        if (usageParts.length) metaParts.push(`<span class="msg-meta-item">${usageParts.join(' / ')}</span>`);
      } else if (msg.tokens) {
        metaParts.push(`<span class="msg-meta-item">~${formatTokenCount(msg.tokens)} tokens</span>`);
      }
      if (!isUser && msg.model) metaParts.push(`<span class="msg-meta-item msg-model-tag">${esc(msg.model)}</span>`);
      metaParts.push(`
        <span class="copy-menu">
          <button class="msg-action-btn" data-action="copy-menu" data-idx="${i}" title="复制" data-tooltip="复制">${SVG_COPY}</button>
          <span class="copy-menu-popover">
            <button type="button" data-action="copy-md" data-idx="${i}">复制 Markdown</button>
            <button type="button" data-action="copy-text" data-idx="${i}">复制纯文本</button>
          </span>
        </span>
      `);
      if (isUser) metaParts.push(`<button class="msg-action-btn" data-action="edit" data-idx="${i}" title="继续提问" data-tooltip="继续提问">${SVG_EDIT}</button>`);
      if (!isUser) metaParts.push(`<button class="msg-action-btn" data-action="retry" data-idx="${i}" title="重新生成，会替换这条回复之后的内容" data-tooltip="重新生成，会替换后续内容">${SVG_REFRESH}</button>`);
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
        <div class="chat-msg-avatar">${AI_AVATAR}</div>
        <div class="chat-msg-body">
          <div class="typing-dots"><span></span><span></span><span></span></div>
        </div>
      </div>
    `;
    dom.messages.classList.add('has-messages');
    dom.welcome.classList.add('hidden');
    updateConversationTokenSummary();
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
        <div class="chat-msg-avatar">${AI_AVATAR}</div>
        <div class="chat-msg-body">
          <div class="stream-waiting">
            <span>正在思考</span>
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
    dom.messages.appendChild(el);
    dom.messages.scrollTop = dom.messages.scrollHeight;
    return {
      thinkingMd: el.querySelector('.thinking-content .msg-md'),
      thinkingBlock: el.querySelector('.thinking-block'),
      thinkingLabel: el.querySelector('.thinking-label'),
      contentMd: el.querySelector('.chat-msg-body > .msg-md'),
      waiting: el.querySelector('.stream-waiting'),
    };
  }

  function updateStream(el, text) {
    scheduleStreamRender(() => {
      el.innerHTML = renderMd(text);
      dom.messages.scrollTop = dom.messages.scrollHeight;
    });
  }

  function updateThinkingStream(streamEls, reasoningContent, reasoningStartTime, streamStartTime, conv = currentConv()) {
    if (!conversationShowThinking(conv)) return;
    scheduleStreamRender(() => {
      streamEls.waiting?.classList.add('hidden');
      if (streamEls.thinkingBlock.classList.contains('hidden')) {
        streamEls.thinkingBlock.classList.remove('hidden');
        streamEls.thinkingBlock.classList.add('expanded');
      }
      const thinkingMs = Date.now() - (reasoningStartTime || streamStartTime);
      streamEls.thinkingLabel.textContent = `思考中... · ${thinkingMs >= 1000 ? (thinkingMs / 1000).toFixed(1) + 's' : thinkingMs + 'ms'}`;
      streamEls.thinkingMd.innerHTML = renderMd(reasoningContent);
      dom.messages.scrollTop = dom.messages.scrollHeight;
    });
  }

  // ===== Model Dropdown =====
  function renderModelDropdown() {
    const models = state.mode === 'image'
      ? mergeUnique([state.imageModel], state.imageModelsCache, DEFAULT_IMAGE_MODELS)
      : state.modelsCache;
    const current = state.mode === 'image' ? state.imageModel : state.model;
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
    mergeUnique([state.model], state.modelsCache, current.source === 'chat' ? [current.model] : []).forEach(m => {
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
    mergeUnique([state.model], state.modelsCache, current.source === 'chat' ? [current.model] : []).forEach(m => {
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
    const retryUserMsg = opts.userMessage ? cloneMessage(opts.userMessage) : null;
    if (!retryUserMsg && hasPendingFileReads()) {
      showToast('附件还在读取中，请稍后发送');
      updateSendBtn();
      return;
    }

    const inputTokens = retryUserMsg?.tokens || estimateTokens(userContent);
    const includeContext = opts.includeContext ?? conversationIncludeContext(conv);

    // Build user message content (plain text or multimodal)
    const files = state.pendingFiles.filter(isFileReady);
    if (!retryUserMsg && !userContent.trim() && files.length === 0) return;
    let userMsgData;
    if (retryUserMsg) {
      userMsgData = retryUserMsg;
      userMsgData.includeContext = includeContext;
      userMsgData.timestamp = Date.now();
    } else if (files.length > 0) {
      const contentParts = [{ type: 'text', text: userContent }];
      for (const f of files) {
        if (f.base64) {
          contentParts.push({ type: 'image_url', image_url: { url: f.base64 } });
        } else if (f.text) {
          contentParts.push({ type: 'text', text: `[文件: ${f.name}]\n${f.text}` });
        }
      }
      userMsgData = { role: 'user', content: contentParts, tokens: inputTokens, timestamp: Date.now(), includeContext, files: files.map(f => ({ name: f.name, type: f.type, base64: f.base64 })) };
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
    const sourceMessages = includeContext ? conv.messages : [userMsgData];
    const rawApiMessages = sourceMessages.map(m => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      return { role: m.role, content: m.content };
    });
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
    await writeStreamSession({ convId: conv.id, model: state.model, requestInputTokens, includeContext, startTime: Date.now() });

    addTyping();

    // Add a placeholder streaming message to conv.messages for crash recovery
    const streamPlaceholder = { role: 'assistant', content: '', tokens: 0, model: state.model, requestInputTokens, streaming: true };
    conv.messages.push(streamPlaceholder);
    const streamMsgIdx = conv.messages.length - 1;
    persist([KEYS.conversations, KEYS.currentConvId]);

    // Build request params for the Service Worker to make the ONLY API call
    const reqBody = { model: state.model, messages: apiMessages, stream: true };
    reqBody.temperature = conv.temperature;
    reqBody.top_p = conv.topP;
    reqBody.max_tokens = conv.maxTokens;
    reqBody.stream_options = { include_usage: true };
    const streamUrl = requestUrl(state.baseUrl, '/chat/completions');
    const swAvailable = navigator.serviceWorker?.controller;

    if (swAvailable) {
      // === SW proxy mode: SW makes the only fetch, page reads from IndexedDB ===
      navigator.serviceWorker.controller.postMessage({
        type: 'start-stream',
        url: streamUrl,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.apiKey}` },
        body: JSON.stringify(reqBody),
        convId: conv.id,
        model: state.model,
        requestInputTokens,
        includeContext,
      });

      // Set up abort via SW message
      state.chatAbortController = { abort: () => {
        navigator.serviceWorker.controller.postMessage({ type: 'stop-stream' });
      }};

      removeTyping();
      state.streamEls = addStreamMsg();
      const streamEls = state.streamEls;
      const streamStartTime = Date.now();
      let firstTokenTime = null;
      let outputStartTime = null;
      let reasoningStartTime = null;
      let reasoningEndTime = null;
      let lastContent = '';

      // Poll IndexedDB for stream progress (every 100ms)
      state.chatPollTimer = setInterval(async () => {
        const session = await getStreamSession();
        if (!session) return;
        if (session.convId && session.convId !== conv.id) return;

        const content = session.assistantContent || '';
        const reasoning = session.reasoningContent || '';
        const usage = normalizeUsage(session.usage);

        if (content && firstTokenTime === null) {
          firstTokenTime = Date.now() - streamStartTime;
          outputStartTime = Date.now();
        }

        // Update thinking block
        if (conversationShowThinking(conv) && reasoning) {
          if (reasoningStartTime === null) reasoningStartTime = Date.now();
          if (streamEls.thinkingBlock.classList.contains('hidden')) {
            streamEls.thinkingBlock.classList.remove('hidden');
            streamEls.thinkingBlock.classList.add('expanded');
          }
          const thinkingMs = Date.now() - (reasoningStartTime || streamStartTime);
          streamEls.thinkingLabel.textContent = `思考中... · ${thinkingMs >= 1000 ? (thinkingMs / 1000).toFixed(1) + 's' : thinkingMs + 'ms'}`;
          streamEls.thinkingMd.innerHTML = renderMd(reasoning);
        }

        // Update content
        if (content !== lastContent) {
          lastContent = content;
          streamEls.waiting?.classList.toggle('hidden', !!content.trim());
          if (conv.messages[streamMsgIdx]?.streaming) {
            conv.messages[streamMsgIdx].content = content;
            conv.messages[streamMsgIdx].tokens = usageOutputTokens(usage, estimateTokens(content));
            if (usage) conv.messages[streamMsgIdx].usage = usage;
            if (reasoning) conv.messages[streamMsgIdx].reasoningContent = reasoning;
            if (firstTokenTime !== null) conv.messages[streamMsgIdx].firstTokenMs = firstTokenTime;
          }
          updateConversationTokenSummary();
          streamEls.contentMd.innerHTML = renderMd(content);
          dom.messages.scrollTop = dom.messages.scrollHeight;
        }

        // Collapse thinking block when reasoning is done and content starts
        if (conversationShowThinking(conv) && reasoning && content && reasoningEndTime === null) {
          reasoningEndTime = Date.now();
          streamEls.thinkingBlock.classList.remove('expanded');
          const thinkingMs = reasoningEndTime - (reasoningStartTime || streamStartTime);
          streamEls.thinkingLabel.textContent = `思考过程 · ${thinkingMs >= 1000 ? (thinkingMs / 1000).toFixed(1) + 's' : thinkingMs + 'ms'}`;
        }

        // Handle stream completion
        if (session.status === 'complete' || session.status === 'error' || session.status === 'stopped') {
          clearInterval(state.chatPollTimer);
          state.chatPollTimer = null;

          const finalSession = await getStableStreamSession(session);
          const finalContent = finalSession.assistantContent || content;
          const finalReasoning = finalSession.reasoningContent || reasoning;
          const finalUsage = normalizeUsage(finalSession.usage) || usage;
          const estimatedOutputTokens = estimateTokens(finalContent);
          const outputTokens = usageOutputTokens(finalUsage, estimatedOutputTokens);
          const outputEndTime = Date.now();
          const sessionOutputTimeMs = finalSession.outputTimeMs != null ? Number(finalSession.outputTimeMs) : null;
          const localOutputTimeMs = outputStartTime ? outputEndTime - outputStartTime : null;
          const outputTimeMs = Number.isFinite(sessionOutputTimeMs) ? sessionOutputTimeMs : localOutputTimeMs;
          let msgData;

          if (finalSession.status === 'error') {
            const detail = finalSession.error ? `\n\n\`\`\`text\n${finalSession.error}\n\`\`\`` : '';
            msgData = { role: 'assistant', content: `**错误**: 请求失败${detail}`, tokens: 0, model: state.model };
          } else if (finalSession.status === 'stopped') {
            const stoppedContent = finalContent.trim()
              ? `${finalContent}\n\n_已停止生成_`
              : '**已停止生成**';
            msgData = { role: 'assistant', content: stoppedContent, tokens: outputTokens, model: state.model };
            if (finalUsage) msgData.usage = finalUsage;
            if (firstTokenTime !== null) msgData.firstTokenMs = firstTokenTime;
            if (finalReasoning) msgData.reasoningContent = finalReasoning;
            if (Number.isFinite(outputTimeMs)) msgData.outputTimeMs = outputTimeMs;
          } else {
            msgData = { role: 'assistant', content: finalContent, tokens: outputTokens, model: state.model };
            if (finalUsage) msgData.usage = finalUsage;
            if (firstTokenTime !== null) msgData.firstTokenMs = firstTokenTime;
            if (Number.isFinite(outputTimeMs)) msgData.outputTimeMs = outputTimeMs;
            if (finalReasoning) {
              msgData.reasoningContent = finalReasoning;
              msgData.reasoningTimeMs = reasoningEndTime ? reasoningEndTime - (reasoningStartTime || streamStartTime) : null;
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

          state.tokenStats.input += usageInputTokens(finalUsage, requestInputTokens);
          state.tokenStats.output += outputTokens;
          state.tokenStats.total = state.tokenStats.input + state.tokenStats.output;

          persist([KEYS.conversations, KEYS.currentConvId, KEYS.tokenStats]);
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
            const fallbackBody = Object.assign({}, reqBody);
            delete fallbackBody.stream_options;
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
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) return;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') return;
          try {
            const json = JSON.parse(data);
            const usage = normalizeUsage(json.usage);
            if (usage) streamUsage = usage;
            const delta = json.choices?.[0]?.delta;
            const reasoningDelta = delta?.reasoning_content || delta?.thinking || '';
            const contentDelta = delta?.content || '';

            if (reasoningDelta) {
              if (reasoningStartTime === null) reasoningStartTime = Date.now();
              apiReasoningContent += reasoningDelta;
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
                updateThinkingStream(streamEls, reasoningContent, reasoningStartTime, streamStartTime, conv);
              }
              if (reasoningContent && !splitContent.openThink && reasoningEndTime === null) {
                reasoningEndTime = Date.now();
                streamEls.thinkingBlock.classList.remove('expanded');
                const thinkingMs = reasoningEndTime - (reasoningStartTime || streamStartTime);
                streamEls.thinkingLabel.textContent = `思考过程 · ${thinkingMs >= 1000 ? (thinkingMs / 1000).toFixed(1) + 's' : thinkingMs + 'ms'}`;
              }
              streamEls.waiting?.classList.toggle('hidden', !!splitContent.content.trim());
              updateStream(streamEls.contentMd, splitContent.content);
              if (conv.messages[streamMsgIdx]?.streaming) {
                conv.messages[streamMsgIdx].content = splitContent.content;
                conv.messages[streamMsgIdx].tokens = usageOutputTokens(streamUsage, estimateTokens(splitContent.content));
                if (streamUsage) conv.messages[streamMsgIdx].usage = streamUsage;
                if (reasoningContent) conv.messages[streamMsgIdx].reasoningContent = reasoningContent;
                if (firstTokenTime !== null) conv.messages[streamMsgIdx].firstTokenMs = firstTokenTime;
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
        const msgData = { role: 'assistant', content: finalContent, tokens: outputTokens, model: state.model };
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

        state.tokenStats.input += usageInputTokens(streamUsage, requestInputTokens);
        state.tokenStats.output += outputTokens;
        state.tokenStats.total = state.tokenStats.input + state.tokenStats.output;

        persist([KEYS.conversations, KEYS.currentConvId, KEYS.tokenStats]);
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
          if (firstTokenTime !== null) stoppedMsg.firstTokenMs = firstTokenTime;
          if (outputStartTime) stoppedMsg.outputTimeMs = Date.now() - outputStartTime;
          if (reasoningContent) stoppedMsg.reasoningContent = reasoningContent;
          if (conv.messages[streamMsgIdx]?.streaming) conv.messages[streamMsgIdx] = stoppedMsg;
          else conv.messages.push(stoppedMsg);
        } else {
          const detail = e.diagnostics ? `\n\n\`\`\`text\n${e.diagnostics}\n\`\`\`` : '';
          const errMsg = { role: 'assistant', content: `**错误**: ${e.message}${detail}`, tokens: 0 };
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
    dom.cfgImageBaseUrl.value = effectiveImageBaseUrl();
    dom.cfgImageApiKey.value = effectiveImageApiKey();
    populateSelectFromCache(dom.cfgImageModelSelect, { image: true });
    dom.cfgImageModelSelect.value = state.imageModel;
    dom.cfgImageModelManual.value = '';
    dom.cfgImageModelManual.placeholder = `手动填写模型，当前 ${state.imageModel || 'gpt-image-2'}`;
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
    if (isImage) updateImageHistorySummary();
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
        renderImageWorkspace();
        scrollImageWorkspaceToBottom(false);
      }
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

  function imageJobReplies(job) {
    if (!job) return [];
    if (Array.isArray(job.replies) && job.replies.length) return job.replies;
    return [{
      id: `${job.id}-reply-0`,
      model: job.model,
      mapModel: job.mapModel,
      prompt: job.prompt,
      inputImage: job.inputImage || null,
      params: job.params || DEFAULT_IMAGE_PARAMS,
      outputs: job.outputs || [],
      error: job.error || null,
      status: job.status || 'done',
      startedAt: job.startedAt || job.createdAt,
      createdAt: job.startedAt || job.createdAt,
      estimatedSeconds: job.estimatedSeconds,
      durationMs: job.durationMs,
    }];
  }

  function ensureImageJobReplies(job) {
    if (!job) return [];
    if (!Array.isArray(job.replies) || !job.replies.length) {
      job.replies = imageJobReplies(job);
    }
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

  function attachmentImageFilename(item) {
    const fallback = `attachment.${item.format || 'png'}`;
    return (item.name || fallback).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || fallback;
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

  function imageViewerItemsForJob(job, scope = 'outputs') {
    if (!job) return [];
    const items = [];
    imageJobReplies(job).forEach((reply, replyIndex) => {
      if (scope === 'inputs' && reply.inputImage?.base64) {
        const format = (reply.inputImage.type || '').replace(/^image\//, '') || (reply.params || job.params)?.outputFormat || 'png';
        items.push({
          jobId: job.id,
          inputRef: true,
          inputImage: reply.inputImage,
          replyIndex,
          src: reply.inputImage.base64,
          out: { b64: reply.inputImage.base64.split(',').pop(), format },
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

  function openImageViewer(job, out, replyIndex = 0) {
    const scope = out.inputRef ? 'inputs' : 'outputs';
    const items = imageViewerItemsForJob(job, scope);
    const reply = imageJobReplies(job)[replyIndex];
    let itemIndex = items.findIndex(item => {
      if (out.inputRef) return item.inputRef && item.replyIndex === replyIndex && item.inputImage === (out.inputImage || null);
      return !item.inputRef && item.replyIndex === replyIndex && item.out === out;
    });
    if (itemIndex < 0 && !out.inputRef) {
      const outputIndex = reply?.outputs?.indexOf(out) ?? 0;
      itemIndex = items.findIndex(item => !item.inputRef && item.replyIndex === replyIndex && item.index === outputIndex);
    }
    state.viewerImage = {
      jobId: job.id,
      items,
      itemIndex: Math.max(0, itemIndex),
    };
    resetImageViewerTransform();
    syncImageViewer();
    dom.imageViewer.classList.remove('hidden');
  }

  function openAttachmentImageViewer(src, name = 'attachment') {
    state.viewerImage = { attachment: true, src, name };
    resetImageViewerTransform();
    syncImageViewer();
    dom.imageViewer.classList.remove('hidden');
  }

  function closeImageViewer() {
    dom.imageViewer.classList.add('hidden');
    dom.imageViewerImg.src = '';
    state.viewerImage = null;
    state.imageViewerDragging = null;
    state.imageViewerTouch = null;
    dom.imageViewerCounter.textContent = '';
    dom.imageViewerCounter.classList.add('hidden');
    dom.imageViewerPrev.classList.add('hidden');
    dom.imageViewerNext.classList.add('hidden');
  }

  function currentViewerImage() {
    if (!state.viewerImage) return null;
    if (state.viewerImage.attachment) {
      const src = state.viewerImage.src;
      const mime = src.match(/^data:([^;]+)/)?.[1] || 'image/png';
      const format = normalizeImageFormat(mime) || 'png';
      return {
        attachment: true,
        src,
        name: state.viewerImage.name || `attachment.${format}`,
        format,
      };
    }
    if (Array.isArray(state.viewerImage.items)) {
      const item = state.viewerImage.items[state.viewerImage.itemIndex || 0];
      const job = state.imageJobs.find(j => j.id === item?.jobId);
      return job && item?.out ? { job, out: item.out } : null;
    }
    const job = state.imageJobs.find(j => j.id === state.viewerImage.jobId);
    if (state.viewerImage.inputRef) {
      const inputImage = state.viewerImage.inputImage || job?.inputImage;
      if (!inputImage) return null;
      const reply = imageJobReplies(job)[state.viewerImage.replyIndex || 0];
      const format = (inputImage.type || '').replace(/^image\//, '') || (reply?.params || job.params)?.outputFormat || 'png';
      return {
        job,
        out: { b64: inputImage.base64.split(',').pop(), format },
      };
    }
    const { reply, out } = imageReplyOutput(job, state.viewerImage.replyIndex || 0, state.viewerImage.index);
    return job && out ? { job, out } : null;
  }

  function syncImageViewer() {
    const viewer = state.viewerImage;
    if (!viewer) return;
    if (viewer.attachment) {
      dom.imageViewerImg.src = viewer.src;
      dom.imageViewerCounter.textContent = '';
      dom.imageViewerCounter.classList.add('hidden');
      dom.imageViewerPrev.classList.add('hidden');
      dom.imageViewerNext.classList.add('hidden');
      return;
    }
    if (!Array.isArray(viewer.items)) return;
    const total = viewer.items.length;
    const itemIndex = Math.min(Math.max(viewer.itemIndex || 0, 0), Math.max(total - 1, 0));
    viewer.itemIndex = itemIndex;
    const item = viewer.items[itemIndex];
    if (item) dom.imageViewerImg.src = item.src;
    dom.imageViewerCounter.textContent = total > 1 ? `${itemIndex + 1} / ${total}` : '';
    dom.imageViewerCounter.classList.toggle('hidden', total <= 1);
    dom.imageViewerPrev.classList.toggle('hidden', total <= 1);
    dom.imageViewerNext.classList.toggle('hidden', total <= 1);
  }

  function switchImageViewerImage(direction) {
    const viewer = state.viewerImage;
    if (!viewer || !Array.isArray(viewer.items) || viewer.items.length <= 1) return;
    const total = viewer.items.length;
    viewer.itemIndex = (viewer.itemIndex + direction + total) % total;
    resetImageViewerTransform();
    syncImageViewer();
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

  function formatDateTime(ts) {
    const d = new Date(ts || Date.now());
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function imageTimeoutMs(params) {
    return Math.max(10 * 60 * 1000, estimateImageSeconds(params) * 1000 * 3);
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
    job.status = 'cancelled';
    job.error = reason;
    job.durationMs = Date.now() - (job.startedAt || job.createdAt);
    const activeReply = currentImageActiveReply(job);
    if (activeReply?.status === 'generating') {
      activeReply.status = 'cancelled';
      activeReply.error = reason;
      activeReply.durationMs = job.durationMs;
    }
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

  async function updateImageHistorySummary() {
    const usage = await estimateImageDbUsage();
    const outputCount = state.imageJobs.reduce((sum, job) => {
      return sum + imageJobReplies(job).reduce((n, reply) => n + (reply.outputs?.length || 0), 0);
    }, 0);
    dom.imageHistorySummary.textContent = `绘画历史 ${state.imageJobs.length} 条，图片 ${outputCount} 张，浏览器存储约 ${formatBytes(usage) || '未知'}`;
  }

  function renderImageWorkspace() {
    const selected = currentImageJob();
    const jobs = selected ? [selected] : [];
    dom.imageEmpty.classList.toggle('hidden', !!selected);
    dom.imageGallery.innerHTML = jobs.map(job => {
      const renderUserMessage = (prompt, inputImage, createdAt, params = job.params || DEFAULT_IMAGE_PARAMS, replyIndex = '') => {
        const inputRef = inputImage
          ? `<div class="image-input-ref">
              <img src="${esc(inputImage.base64)}" alt="${esc(inputImage.name || '参考图')}" class="image-input-preview" data-job="${esc(job.id)}" data-reply="${esc(String(replyIndex))}">
              <span>参考图：${esc(inputImage.name || '生成图')}</span>
            </div>`
          : '';
        return `
          <div class="image-chat-msg user">
            <div class="image-chat-inner">
              <div class="image-chat-avatar">${SVG_PERSON}</div>
              <div class="image-chat-bubble image-chat-bubble-prompt">
                <div class="image-chat-prompt">${esc(prompt || '')}</div>
                ${inputRef}
                <div class="image-msg-meta">
                  <span>${formatDateTime(createdAt || job.createdAt)}</span>
                  <span>~${formatTokenCount(estimateTokens(prompt))} tokens</span>
                  <button class="msg-action-btn image-action" data-action="copy-prompt" data-job="${job.id}" data-prompt="${esc(prompt || '')}" type="button" title="复制提示词" data-tooltip="复制提示词">${SVG_COPY}</button>
                  <button class="msg-action-btn image-action" data-action="reuse" data-job="${job.id}" data-prompt="${esc(prompt || '')}" data-size="${esc(params.size || '')}" data-quality="${esc(params.quality || '')}" data-format="${esc(params.outputFormat || '')}" data-background="${esc(params.background || '')}" type="button" title="复用到输入框" data-tooltip="复用到输入框">${SVG_EDIT}</button>
                </div>
              </div>
            </div>
          </div>
        `;
      };
      const userMessage = renderUserMessage(job.prompt, job.inputImage, job.createdAt, job.params);
      const replies = imageJobReplies(job);
      const replyMessages = replies.map((reply, replyIndex) => {
        const params = reply.params || job.params || DEFAULT_IMAGE_PARAMS;
        const replyUserMessage = replyIndex > 0
          ? renderUserMessage(reply.prompt || job.prompt, reply.inputImage || null, reply.createdAt || reply.startedAt, params, replyIndex)
          : '';
        if (reply.status === 'generating' && !(reply.outputs || []).length && !reply.error) {
          return replyUserMessage;
        }
        const aiMetaParts = [
          reply.model || job.model,
          reply.mapModel ? `映射 ${formatSourcedModel(reply.mapModel)}` : '',
          params.size,
          params.quality !== 'auto' ? params.quality : '',
          params.outputFormat ? params.outputFormat.toUpperCase() : '',
          reply.durationMs ? `耗时 ${formatDuration(reply.durationMs)}` : '',
          formatDateTime(reply.durationMs ? (reply.startedAt || reply.createdAt || job.createdAt) + reply.durationMs : (reply.createdAt || job.createdAt)),
        ].filter(Boolean).map(item => `<span>${esc(item)}</span>`).join('');
        const outputs = (reply.outputs || []).map((out, i) => {
          const outputMeta = imageOutputMeta(out, params.outputFormat).map(esc).join('<span>·</span>');
          return `
          <div class="image-result" data-job="${esc(job.id)}" data-reply="${replyIndex}" data-index="${i}">
            <img src="${esc(dataUrlForImage(out, params.outputFormat))}" alt="${esc(job.prompt)}" loading="lazy" class="image-preview">
            <div class="image-result-meta">${outputMeta}</div>
            <div class="image-result-actions">
              <button class="msg-action-btn image-action" data-action="view" data-job="${job.id}" data-reply="${replyIndex}" data-index="${i}" title="放大查看" data-tooltip="放大查看">${SVG_MAXIMIZE}</button>
              <button class="msg-action-btn image-action" data-action="use-as-ref" data-job="${job.id}" data-reply="${replyIndex}" data-index="${i}" title="以图编辑" data-tooltip="以图编辑">${SVG_EDIT}</button>
              <button class="msg-action-btn image-action" data-action="copy-image" data-job="${job.id}" data-reply="${replyIndex}" data-index="${i}" title="复制图片" data-tooltip="复制图片">${SVG_COPY}</button>
              <button class="msg-action-btn image-action" data-action="download" data-job="${job.id}" data-reply="${replyIndex}" data-index="${i}" title="下载" data-tooltip="下载">${SVG_DOWNLOAD}</button>
            </div>
          </div>
        `;
        }).join('');
        return `
          ${replyUserMessage}
          <div class="image-chat-msg ai">
            <div class="image-chat-inner">
              <div class="image-chat-avatar image-ai-avatar" aria-label="AI"></div>
              <div class="image-chat-bubble image-chat-bubble-result">
                ${reply.error ? `<div class="image-error">${esc(reply.error)}</div>` : ''}
                <div class="image-results">${outputs}</div>
                <div class="image-msg-meta">${aiMetaParts}</div>
                <div class="image-job-actions">
                  <button class="btn-secondary image-action" data-action="edit-latest" data-job="${job.id}" data-reply="${replyIndex}" type="button">编辑</button>
                  <button class="btn-secondary image-action" data-action="retry" data-job="${job.id}" data-reply="${replyIndex}" type="button">${reply.status === 'generating' ? '生成中' : '重绘'}</button>
                </div>
              </div>
            </div>
          </div>
        `;
      }).join('');
      const waitedMs = Date.now() - (job.startedAt || job.createdAt);
      const progress = job.status === 'generating'
        ? `<div class="image-progress" data-job="${esc(job.id)}">
            <div class="image-progress-indicator">
              <div class="image-spinner"></div>
            </div>
            <div class="image-progress-body">
              <div class="image-progress-title">正在生成图片</div>
              <div class="image-progress-stats">
                <span class="image-progress-elapsed">耗时 ${formatDuration(waitedMs)}</span>
              </div>
              <div class="image-progress-note">正在生成，请勿关闭页面</div>
            </div>
            <button class="btn-secondary image-action image-cancel-btn" data-action="cancel" data-job="${job.id}" type="button">取消</button>
          </div>`
        : '';
      const progressMessage = progress
        ? `<div class="image-chat-msg ai">
            <div class="image-chat-inner">
              <div class="image-chat-avatar image-ai-avatar" aria-label="AI"></div>
              <div class="image-chat-bubble image-chat-bubble-progress">${progress}</div>
            </div>
          </div>`
        : '';
      return `
        <article class="image-job-card" data-id="${job.id}">
          ${userMessage}
          ${replyMessages}
          ${progressMessage}
        </article>
      `;
    }).join('');
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
    const endpoint = imageMapEndpoint();
    const url = requestUrl(endpoint.baseUrl, '/responses');
    const body = {
      model: endpoint.model,
      input: mappedImageInput(prompt, ref),
      tools: [imageToolOptions(params)],
      tool_choice: 'required',
    };
    let resp = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      body.tool_choice = { type: 'image_generation' };
      resp = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${endpoint.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    }
    if (!resp.ok && (body.tools[0].output_format || body.tools[0].background || body.tools[0].quality || body.tools[0].size)) {
      const fallback = {
        model: endpoint.model,
        input: mappedImageInput(prompt, ref),
        tools: [{ type: 'image_generation' }],
        tool_choice: 'required',
      };
      resp = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${endpoint.apiKey}` },
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
      const lang = promptLanguageInstruction(prompt);
      const optimizeUrl = requestUrl(endpoint.baseUrl, '/chat/completions');
      const resp = await apiFetch(optimizeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${endpoint.apiKey}` },
        body: JSON.stringify({
          model,
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
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: { message: `HTTP ${resp.status}` } }));
        throw httpError(resp.status, err.error?.message || `HTTP ${resp.status}`, optimizeUrl);
      }
      const optimized = extractChatText(await resp.json()).replace(/^["“]|["”]$/g, '').trim();
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

  async function requestOneImage(prompt, params, signal = null) {
    const imageBaseUrl = effectiveImageBaseUrl();
    const imageApiKey = effectiveImageApiKey();
    const url = requestUrl(imageBaseUrl, '/images/generations');
    let body = buildImageRequestBody(prompt, params);
    let resp = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${imageApiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok && (body.output_format || body.background || body.quality)) {
      body = { model: state.imageModel, prompt: prompt.trim(), n: 1 };
      if (params.size !== 'auto') body.size = params.size;
      resp = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${imageApiKey}` },
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
    const imageBaseUrl = effectiveImageBaseUrl();
    const imageApiKey = effectiveImageApiKey();
    const url = requestUrl(imageBaseUrl, '/images/edits');
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
      headers: { 'Authorization': `Bearer ${imageApiKey}` },
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
        headers: { 'Authorization': `Bearer ${imageApiKey}` },
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

  async function generateImage(prompt, params = state.imageDefaults, retryJob = null, refOverride = undefined) {
    if (!ensureModeConfigured('image')) return;
    if (!imageMapConfigured()) {
      showSettings('image');
      showToast('请完善映射模型对应的接口配置');
      return;
    }
    if (!prompt.trim() || state.isGeneratingImage) return;

    state.isGeneratingImage = true;
    const controller = new AbortController();
    state.imageAbortController = controller;
    requestImageWakeLock();
    updateImageGenerateBtn();
    const startedAt = Date.now();
    const refSource = refOverride !== undefined ? refOverride : state.imageRef;
    const ref = refSource ? Object.assign({}, refSource) : null;
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
    if (!job.replies) job.replies = imageJobReplies(job);
    let activeReply = null;
    if (!retryJob) {
      state.imageJobs.unshift(job);
      state.currentImageJobId = job.id;
      activeReply = job.replies[0];
    } else {
      job.model = state.imageModel;
      job.mapModel = state.imageMapModel;
      job.params = Object.assign({}, params);
      job.error = null;
      job.status = 'generating';
      job.startedAt = startedAt;
      job.estimatedSeconds = estimatedSeconds;
      job.durationMs = null;
      activeReply = {
        id: `${job.id}-reply-${Date.now()}`,
        model: state.imageModel,
        mapModel: state.imageMapModel,
        prompt: prompt.trim(),
        inputImage: ref ? { name: ref.name, type: ref.type, base64: ref.base64 } : null,
        params: Object.assign({}, params),
        outputs: [],
        error: null,
        status: 'generating',
        startedAt,
        createdAt: startedAt,
        estimatedSeconds,
        durationMs: null,
      };
      job.replies.push(activeReply);
    }
    persist();
    imageDbPutJob(job);
    updateSidebar();
    renderImageWorkspace();
    scrollImageWorkspaceToBottom();
    startImageProgressTimer();
    let timeoutId = null;
    const failImageJob = (message, status = 'error') => {
      const isCancelled = status === 'cancelled';
      const durationMs = Date.now() - startedAt;
      activeReply.error = message || (isCancelled ? '请求已中断' : '生成失败');
      activeReply.status = isCancelled ? 'cancelled' : 'error';
      activeReply.durationMs = durationMs;
      job.error = activeReply.error;
      job.status = activeReply.status;
      job.durationMs = durationMs;
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
        state.imageAbortController = { abort: () => {
          swTarget.postMessage({ type: 'stop-image' });
        }};
        const imageBaseUrl = effectiveImageBaseUrl();
        const imageApiKey = effectiveImageApiKey();
        const swHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${imageApiKey}` };

        let swData;
        if (state.imageMapModel) {
          const mapEndpoint = imageMapEndpoint();
          const body = {
            model: mapEndpoint.model,
            input: mappedImageInput(prompt, ref),
            tools: [imageToolOptions(params)],
            tool_choice: 'required',
          };
          swData = {
            type: 'start-image', jobId: job.id,
            url: requestUrl(mapEndpoint.baseUrl, '/responses'),
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mapEndpoint.apiKey}` },
            body: JSON.stringify(body),
            requestType: 'responses', outputFormat: params.outputFormat,
          };
        } else if (ref) {
          swData = {
            type: 'start-image', jobId: job.id,
            url: requestUrl(imageBaseUrl, '/images/edits'),
            headers: swHeaders,
            requestType: 'edit', outputFormat: params.outputFormat,
            formParams: {
              model: state.imageModel, prompt: prompt.trim(),
              imageBase64: ref.base64, imageFilename: ref.name,
              size: params.size, quality: params.quality,
              outputFormat: params.outputFormat, background: params.background,
            },
          };
        } else {
          const body = buildImageRequestBody(prompt, params);
          swData = {
            type: 'start-image', jobId: job.id,
            url: requestUrl(imageBaseUrl, '/images/generations'),
            headers: swHeaders, body: JSON.stringify(body),
            requestType: 'generations', outputFormat: params.outputFormat,
          };
        }
        swTarget.postMessage(swData);

        // Poll IndexedDB for image result (every 500ms)
        state.imagePollTimer = setInterval(async () => {
          const session = await getImageSession();
          const timedOut = Date.now() - startedAt > imageTimeoutMs(params);
          if (!session) {
            if (timedOut) {
              failImageJob('生成超时，请稍后重试。');
              showToast('生成超时');
              finishImageJob();
            }
            return;
          }
          if (session.jobId && session.jobId !== job.id) return;

          if (session.status === 'complete') {
            const nextOutputs = JSON.parse(session.outputs || '[]');
            if (nextOutputs.length === 0) {
              activeReply.error = '接口未返回可显示的图片数据';
              activeReply.status = 'error';
              job.error = activeReply.error;
              job.status = 'error';
            } else {
              activeReply.outputs = nextOutputs;
              activeReply.error = null;
              activeReply.status = 'done';
              job.outputs = nextOutputs;
              job.error = null;
              job.status = 'done';
            }
            activeReply.durationMs = Date.now() - startedAt;
            job.durationMs = activeReply.durationMs;
            if (ref) { state.imageRef = null; renderImageRefPreview(); }
            if (job.status === 'done') showToast('图片已生成');
            else showToast('生成失败');
            finishImageJob();
            await clearImageSession();
          } else if (session.status === 'error') {
            failImageJob(session.error || '生成失败');
            showToast('生成失败');
            finishImageJob();
            await clearImageSession();
          } else if (session.status === 'stopped') {
            failImageJob('请求已中断', 'cancelled');
            showToast('生成已中断');
            finishImageJob();
            await clearImageSession();
          } else if (timedOut || Date.now() - (session.updatedAt || startedAt) > imageTimeoutMs(params)) {
            failImageJob('生成超时，请稍后重试。');
            showToast('生成超时');
            finishImageJob();
            await clearImageSession();
          }
        }, 500);

      } else {
        // === Fallback: no SW, direct fetch ===
        timeoutId = setTimeout(() => controller.abort(), imageTimeoutMs(params));
        const nextOutputs = state.imageMapModel
          ? await requestMappedImage(prompt, params, ref, controller.signal)
          : ref
            ? await requestImageEdit(prompt, params, ref, controller.signal)
            : await requestOneImage(prompt, params, controller.signal);
        if (nextOutputs.length === 0) throw new Error('接口未返回可显示的图片数据');
        activeReply.outputs = nextOutputs;
        activeReply.error = null;
        activeReply.status = 'done';
        activeReply.durationMs = Date.now() - startedAt;
        job.outputs = nextOutputs;
        job.error = null;
        job.status = 'done';
        job.durationMs = activeReply.durationMs;
        if (ref) { state.imageRef = null; renderImageRefPreview(); }
        showToast('图片已生成');
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
      state.imageRef = null;
      renderImageRefPreview();
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
      dom.paramTemperature.value = conv.temperature;
      dom.paramTopP.value = conv.topP;
      dom.paramMaxTokens.value = tokensToK(conv.maxTokens, DEFAULT_MAX_TOKENS);
      dom.paramContextLimit.value = tokensToK(conv.contextLimit, DEFAULT_CONTEXT_LIMIT);
      dom.convRenameInput.value = conv.title;
      dom.convRoleInput.value = conv.systemPrompt || '';
    }
    updateThinkingToggleBtn();
    updateContextToggleBtn();
  }

  function saveConvParams() {
    const conv = currentConv();
    if (!conv) return;
    conv.temperature = parseFloat(dom.paramTemperature.value) || 0.7;
    conv.topP = parseFloat(dom.paramTopP.value) || 1;
    conv.maxTokens = kToTokens(dom.paramMaxTokens.value, DEFAULT_MAX_TOKENS);
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
          state.streamEls.waiting?.classList.add('hidden');
          state.streamEls.thinkingBlock.classList.remove('hidden');
          state.streamEls.thinkingBlock.classList.add('expanded');
          state.streamEls.thinkingMd.innerHTML = renderMd(reasoning);
        }
      } else {
        dom.messages.querySelectorAll('.thinking-block').forEach(el => {
          el.classList.add('hidden');
          el.classList.remove('expanded');
        });
        state.streamEls?.waiting?.classList.toggle('hidden', streamingHasContent);
      }
    } else if (showThinking) {
      renderMessages();
    } else {
      dom.messages.querySelectorAll('.thinking-block').forEach(el => {
        el.classList.add('hidden');
        el.classList.remove('expanded');
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
        const streamStartTime = Date.now();
        let firstTokenTime = null;
        let outputStartTime = null;
        let reasoningStartTime = null;
        let reasoningEndTime = null;
        let lastContent = conv.messages[streamIdx].content || '';

        // Show already-accumulated content
        const initialContent = session.assistantContent || '';
        const initialReasoning = session.reasoningContent || '';
        if (initialContent) {
          streamEls.waiting?.classList.add('hidden');
          streamEls.contentMd.innerHTML = renderMd(initialContent);
          lastContent = initialContent;
        }
        if (conversationShowThinking(conv) && initialReasoning) {
          streamEls.waiting?.classList.add('hidden');
          streamEls.thinkingBlock.classList.remove('hidden');
          streamEls.thinkingBlock.classList.add('expanded');
          streamEls.thinkingMd.innerHTML = renderMd(initialReasoning);
          reasoningStartTime = Date.now() - 1000;
        }
        dom.messages.scrollTop = dom.messages.scrollHeight;

        state.chatAbortController = { abort: () => {
          navigator.serviceWorker.controller.postMessage({ type: 'stop-stream' });
        }};

        state.chatPollTimer = setInterval(async () => {
          const session = await getStreamSession();
          if (!session) return;

          const content = session.assistantContent || '';
          const reasoning = session.reasoningContent || '';

          if (content && firstTokenTime === null) {
            firstTokenTime = Date.now() - streamStartTime;
            outputStartTime = Date.now();
          }

          if (conversationShowThinking(conv) && reasoning) {
            if (reasoningStartTime === null) reasoningStartTime = Date.now();
            if (streamEls.thinkingBlock.classList.contains('hidden')) {
              streamEls.thinkingBlock.classList.remove('hidden');
              streamEls.thinkingBlock.classList.add('expanded');
            }
            const thinkingMs = Date.now() - (reasoningStartTime || streamStartTime);
            streamEls.thinkingLabel.textContent = `思考中... · ${thinkingMs >= 1000 ? (thinkingMs / 1000).toFixed(1) + 's' : thinkingMs + 'ms'}`;
            streamEls.thinkingMd.innerHTML = renderMd(reasoning);
          }

          if (content !== lastContent) {
            lastContent = content;
            streamEls.waiting?.classList.toggle('hidden', !!content.trim());
            streamEls.contentMd.innerHTML = renderMd(content);
            dom.messages.scrollTop = dom.messages.scrollHeight;
          }

          if (conversationShowThinking(conv) && reasoning && content && reasoningEndTime === null) {
            reasoningEndTime = Date.now();
            streamEls.thinkingBlock.classList.remove('expanded');
            const thinkingMs = reasoningEndTime - (reasoningStartTime || streamStartTime);
            streamEls.thinkingLabel.textContent = `思考过程 · ${thinkingMs >= 1000 ? (thinkingMs / 1000).toFixed(1) + 's' : thinkingMs + 'ms'}`;
          }

          if (session.status === 'complete' || session.status === 'error' || session.status === 'stopped') {
            clearInterval(state.chatPollTimer);
            state.chatPollTimer = null;
            if (outputStartTime && !session.outputTimeMs) session.outputTimeMs = Date.now() - outputStartTime;
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
        state.streamEls.waiting?.classList.add('hidden');
        state.streamEls.contentMd.innerHTML = renderMd(existingContent);
      }
      if (conversationShowThinking(conv) && existingReasoning) {
        state.streamEls.waiting?.classList.add('hidden');
        state.streamEls.thinkingBlock.classList.remove('hidden');
        state.streamEls.thinkingBlock.classList.add('expanded');
        state.streamEls.thinkingMd.innerHTML = renderMd(existingReasoning);
      }
      dom.messages.scrollTop = dom.messages.scrollHeight;

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
          state.streamEls.waiting?.classList.add('hidden');
          state.streamEls.contentMd.innerHTML = renderMd(c);
        }
        if (conversationShowThinking(conv) && r) {
          state.streamEls.waiting?.classList.add('hidden');
          state.streamEls.thinkingMd.innerHTML = renderMd(r);
        }
        dom.messages.scrollTop = dom.messages.scrollHeight;
      }, 500);
    }
  }

  // Finalize a completed/failed/stopped stream session into a proper message
  function finalizeStreamFromSession(conv, streamIdx, session) {
    const content = session.assistantContent || '';
    const reasoning = session.reasoningContent || '';
    const usage = normalizeUsage(session.usage);
    const outputTokens = usageOutputTokens(usage, estimateTokens(content));
    const requestInputTokens = Number(session.requestInputTokens || conv.messages[streamIdx]?.requestInputTokens || 0);
    let msgData;
    if (session.status === 'error') {
      const detail = session.error ? `\n\n\`\`\`text\n${session.error}\n\`\`\`` : '';
      msgData = { role: 'assistant', content: `**错误**: 请求失败${detail}`, tokens: 0, model: state.model };
    } else if (session.status === 'stopped') {
      const stoppedContent = content.trim() ? `${content}\n\n_已停止生成_` : '**已停止生成**';
      msgData = { role: 'assistant', content: stoppedContent, tokens: outputTokens, model: state.model };
      if (usage) msgData.usage = usage;
      if (reasoning) msgData.reasoningContent = reasoning;
    } else {
      msgData = { role: 'assistant', content, tokens: outputTokens, model: state.model };
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

    state.tokenStats.input += usageInputTokens(usage, requestInputTokens);
    state.tokenStats.output += outputTokens;
    state.tokenStats.total = state.tokenStats.input + state.tokenStats.output;

    state.isStreaming = false;
    state.streamingConvId = null;
    state.chatAbortController = null;
    releaseChatWakeLock();

    persist([KEYS.conversations, KEYS.currentConvId, KEYS.tokenStats]);
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
    const msgData = { role: 'assistant', content: stoppedContent, tokens: estimateTokens(content), model: state.model };
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
      renderImageWorkspace();
      scrollImageWorkspaceToBottom(false);
      return;
    }

    const deletedConvs = state.conversations.filter(c => idSet.has(c.id));
    state.conversations = state.conversations.filter(c => !idSet.has(c.id));
    if (state.currentConvId && idSet.has(state.currentConvId)) {
      state.currentConvId = state.conversations[0]?.id || null;
    }
    resetSidebarBulkMode();
    persist();
    Promise.allSettled(collectConversationFileIds(deletedConvs).map(fileDbDelete));
    updateSidebar();
    syncConvParams();
    renderMessages();
  }

  function handleSidebarItemActivate(e) {
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
        imageDbDeleteJob(id);
        updateSidebar();
        renderImageWorkspace();
        scrollImageWorkspaceToBottom(false);
        return;
      }
      const item = e.target.closest('.conv-item');
      if (item) {
        state.currentImageJobId = item.dataset.id;
        persist();
        updateSidebar();
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
      Promise.allSettled(collectConversationFileIds([deletedConv]).map(fileDbDelete));
      updateSidebar();
      syncConvParams();
      renderMessages();
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
        showConfigImportConfirm(parseImportConfig(String(reader.result || '')));
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
    }
    if (needImage || ib || ik || dom.cfgImageModelManual.value.trim()) {
      if (!ib || !ik || !im) { alert('绘画配置需要同时填写 Base URL、API Key 和模型'); return; }
      state.imageBaseUrl = normalizeUrl(ib);
      state.imageApiKey = ik;
      state.imageModel = im;
      state.imageMapModel = mapModel || '';
      state.imagePromptModel = promptModel || '';
      state.imageModelsCache = mergeUnique([im], state.imageModelsCache, DEFAULT_IMAGE_MODELS);
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
    state.baseUrl = normalizeUrl(b);
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
    if (state.mode === 'image') {
      state.imageModel = opt.dataset.model;
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
    const attachmentImage = e.target.closest('.msg-img[data-action="view-attachment-image"]');
    if (attachmentImage) {
      openAttachmentImageViewer(attachmentImage.src, attachmentImage.dataset.name || attachmentImage.alt || 'attachment');
      return;
    }

    const thinkingToggle = e.target.closest('.thinking-toggle');
    if (thinkingToggle) {
      closeCopyMenus();
      thinkingToggle.closest('.thinking-block').classList.toggle('expanded');
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
    const entry = { name, size: file.size, type: file.type, loading: true };
    state.pendingFiles.push(entry);
    renderFilePreview();
    updateSendBtn();

    const reader = new FileReader();
    reader.onload = (ev) => {
      if (file.type.startsWith('image/')) entry.base64 = ev.target.result;
      else entry.text = ev.target.result;
      entry.loading = false;
      delete entry.error;
      renderFilePreview();
      updateSendBtn();
    };
    reader.onerror = () => {
      entry.loading = false;
      entry.error = true;
      renderFilePreview();
      updateSendBtn();
    };
    if (file.type.startsWith('image/')) reader.readAsDataURL(file);
    else reader.readAsText(file);
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
    const name = opts.name || file.name || pastedImageName(file, opts.index || 0);
    const reader = new FileReader();
    reader.onload = ev => {
      state.imageRef = { name, type: file.type, base64: ev.target.result };
      renderImageRefPreview();
      updateImageGenerateBtn();
    };
    reader.onerror = () => showToast('参考图读取失败');
    reader.readAsDataURL(file);
    return true;
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
      const status = f.error ? '<span class="file-status">失败</span>' : (f.loading ? '<span class="file-status">读取中</span>' : '');
      return `<div class="file-preview-item ${f.loading ? 'is-loading' : ''} ${f.error ? 'is-error' : ''}" data-index="${i}">${inner}<span class="file-name">${esc(f.name)}</span>${status}<button class="file-remove" data-index="${i}" type="button">&times;</button></div>`;
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
    if (setImageReferenceFile(files[0], { name: files[0].name || pastedImageName(files[0]) })) {
      showToast(files.length > 1 ? '已使用第一张粘贴图片作为参考图' : '已添加粘贴参考图');
    }
  });
  dom.imageRefBtn.addEventListener('click', () => dom.imageRefInput.click());
  dom.imageOptimizeBtn.addEventListener('click', optimizeImagePrompt);
  dom.imageRefInput.addEventListener('change', () => {
    const file = dom.imageRefInput.files?.[0];
    if (!file) return;
    setImageReferenceFile(file);
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
    generateImage(prompt, state.imageDefaults, currentImageJob());
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
      const inputImage = reply?.inputImage || job?.inputImage;
      if (inputImage) {
        openImageViewer(job, {
          inputRef: true,
          inputImage,
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
      state.imageDefaults = Object.assign({}, DEFAULT_IMAGE_PARAMS, job.params || {}, {
        size: btn.dataset.size || job.params?.size || DEFAULT_IMAGE_PARAMS.size,
        quality: btn.dataset.quality || job.params?.quality || DEFAULT_IMAGE_PARAMS.quality,
        outputFormat: btn.dataset.format || job.params?.outputFormat || DEFAULT_IMAGE_PARAMS.outputFormat,
        background: btn.dataset.background || job.params?.background || DEFAULT_IMAGE_PARAMS.background,
      });
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
      const retryRef = reply?.inputImage || job.inputImage || null;
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
      state.imageRef = {
        name: imageFilename(job, out),
        type: `image/${out.format || reply?.params?.outputFormat || job.params?.outputFormat || 'png'}`,
        base64: dataUrlForImage(out, (reply?.params || job.params)?.outputFormat),
      };
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
      state.imageRef = {
        name: imageFilename(job, out),
        type: `image/${out.format || reply?.params?.outputFormat || job.params?.outputFormat || 'png'}`,
        base64: dataUrlForImage(out, (reply?.params || job.params)?.outputFormat),
      };
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
    const result = img.closest('.image-result');
    if (!result) return;
    updateImageOutputMeta(result.dataset.job, parseInt(result.dataset.index, 10), img);
    if (state.mode === 'image') scrollImageWorkspaceToBottom(false);
  }, true);

  dom.imageViewerClose.addEventListener('click', closeImageViewer);
  dom.imageViewer.querySelector('.image-viewer-backdrop').addEventListener('click', closeImageViewer);
  dom.imageViewerPrev.addEventListener('click', () => switchImageViewerImage(-1));
  dom.imageViewerNext.addEventListener('click', () => switchImageViewerImage(1));
  dom.imageViewerImg.addEventListener('wheel', zoomImageViewer, { passive: false });
  dom.imageViewerImg.addEventListener('pointerdown', startImageViewerDrag);
  dom.imageViewer.addEventListener('pointermove', moveImageViewerDrag);
  dom.imageViewer.addEventListener('pointerup', endImageViewerDrag);
  dom.imageViewer.addEventListener('pointercancel', endImageViewerDrag);
  dom.imageViewerImg.addEventListener('dblclick', resetImageViewerTransform);
  dom.imageViewerImg.addEventListener('touchstart', startImageViewerTouch, { passive: false });
  dom.imageViewerImg.addEventListener('touchmove', moveImageViewerTouch, { passive: false });
  dom.imageViewerImg.addEventListener('touchend', endImageViewerTouch);
  dom.imageViewerImg.addEventListener('touchcancel', endImageViewerTouch);
  dom.imageViewerCopy.addEventListener('click', () => {
    const current = currentViewerImage();
    if (!current) return;
    if (current.attachment) copyAttachmentImage(current);
    else copyImage(current.job, current.out);
  });
  dom.imageViewerDownload.addEventListener('click', () => {
    const current = currentViewerImage();
    if (!current) return;
    if (current.attachment) downloadAttachmentImage(current);
    else downloadImage(current.job, current.out);
  });
  document.addEventListener('keydown', (e) => {
    if (dom.imageViewer.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeImageViewer();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      switchImageViewerImage(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      switchImageViewerImage(1);
    }
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
            oldConv.messages[streamIdx] = { role: 'assistant', content: content.trim() ? `${content}\n\n_已停止生成_` : '**已停止生成**', tokens: estimateTokens(content), model: state.model };
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
    if (hasPendingFileReads()) {
      showToast('附件还在读取中，请稍后发送');
      updateSendBtn();
      return;
    }
    if (!text && !state.pendingFiles.some(isFileReady)) return;
    if (!currentConv()) { newConv(); updateSidebar(); syncConvParams(); }
    dom.userInput.value = '';
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
      const usage = normalizeUsage(session.usage);
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
      const usage = normalizeUsage(session.usage);
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
      const usage = normalizeUsage(session.usage);
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
        const usage = normalizeUsage(session.usage);
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
      const hasReasoning = conversationShowThinking(conv) && !!msg.reasoningContent;
      el.innerHTML = `
        <div class="chat-msg-inner">
          <div class="chat-msg-avatar">${AI_AVATAR}</div>
          <div class="chat-msg-body">
            <div class="stream-waiting">
              <span>正在思考</span>
              <div class="typing-dots"><span></span><span></span><span></span></div>
            </div>
            ${hasReasoning ? `<div class="thinking-block expanded">
              <button class="thinking-toggle" type="button">
                <svg class="thinking-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                <span class="thinking-label">正在恢复思考过程...</span>
              </button>
              <div class="thinking-content"><div class="msg-md"></div></div>
            </div>` : ''}
            <div class="msg-md"></div>
            <div class="msg-meta"><span class="msg-meta-item">正在恢复回复...</span></div>
          </div>
        </div>
      `;
      dom.messages.appendChild(el);
      dom.messages.scrollTop = dom.messages.scrollHeight;
      return {
        contentMd: el.querySelector('.chat-msg-body > .msg-md'),
        thinkingMd: el.querySelector('.thinking-content .msg-md'),
        thinkingLabel: el.querySelector('.thinking-label'),
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
      const usage = normalizeUsage(session.usage);
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
        scheduleStreamRender(() => {
          recoveryEls.waiting?.classList.add('hidden');
          recoveryEls.thinkingMd.innerHTML = renderMd(msg.reasoningContent);
          recoveryEls.thinkingLabel.textContent = `正在恢复思考过程...`;
          recoveryEls.contentMd.innerHTML = renderMd(msg.content);
          dom.messages.scrollTop = dom.messages.scrollHeight;
        });
      } else {
        scheduleStreamRender(() => {
          recoveryEls.waiting?.classList.toggle('hidden', !!(msg.content || '').trim());
          recoveryEls.contentMd.innerHTML = renderMd(msg.content);
          dom.messages.scrollTop = dom.messages.scrollHeight;
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
    const durationMs = Date.now() - (activeReply.startedAt || job.startedAt || job.createdAt || Date.now());
    if (session.status === 'complete') {
      const outputs = JSON.parse(session.outputs || '[]');
      if (outputs.length === 0) {
        activeReply.error = '接口未返回可显示的图片数据';
        activeReply.status = 'error';
        job.error = activeReply.error;
        job.status = 'error';
      } else {
        activeReply.outputs = outputs;
        activeReply.error = null;
        activeReply.status = 'done';
        job.outputs = outputs;
        job.error = null;
        job.status = 'done';
      }
    } else if (session.status === 'stopped') {
      activeReply.error = '请求已中断';
      activeReply.status = 'cancelled';
      job.error = activeReply.error;
      job.status = 'cancelled';
    } else if (session.status === 'error') {
      activeReply.error = session.error || '生成失败';
      activeReply.status = 'error';
      job.error = activeReply.error;
      job.status = 'error';
    } else if (session.status === 'timeout') {
      activeReply.error = '生成超时';
      activeReply.status = 'error';
      job.error = activeReply.error;
      job.status = 'error';
    }
    activeReply.durationMs = durationMs;
    job.durationMs = durationMs;
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

    // Still streaming/connecting — start polling (same pattern as chat recovery)
    if (session.status === 'streaming' || session.status === 'connecting') {
      job.status = 'generating';
      const activeReply = currentImageActiveReply(job);
      if (activeReply) activeReply.status = 'generating';
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
        } else if (s.status === 'error' || s.status === 'stopped') {
          clearInterval(state.imagePollTimer);
          state.imagePollTimer = null;
          state.isGeneratingImage = false;
          releaseImageWakeLock();
          stopImageProgressTimer();
          applyRecoveredImageSession(job, s);
          persist(); imageDbPutJob(job);
          updateSidebar(); renderImageWorkspace(); updateImageGenerateBtn();
          await clearImageSession();
        } else if (Date.now() - s.updatedAt > 600000) {
          // 10 min timeout — SW was likely killed
          clearInterval(state.imagePollTimer);
          state.imagePollTimer = null;
          state.isGeneratingImage = false;
          releaseImageWakeLock();
          stopImageProgressTimer();
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
