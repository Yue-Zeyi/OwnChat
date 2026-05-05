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
  };

  function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
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
    html = html.replace(/^(>.*)$/gm, (_, line) => {
      const content = line.replace(/^>\s?/, '');
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

  // Inline rendering (images before links, strikethrough, bold/italic)
  function renderInline(text) {
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic: only match single * not adjacent to another *
    text = text.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
    return text;
  }

  function esc(t) { return t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

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
  const state = {
    baseUrl: load(KEYS.baseUrl) || '',
    apiKey: load(KEYS.apiKey) || '',
    model: load(KEYS.model) || '',
    modelsCache: load(KEYS.modelsCache) || [],
    conversations: load(KEYS.conversations) || [],
    currentConvId: load(KEYS.currentConvId) || null,
    tokenStats: load(KEYS.tokenStats) || { input: 0, output: 0, total: 0 },
    sidebarCollapsed: load(KEYS.sidebarCollapsed) || false,
    theme: load(KEYS.theme) || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
    isStreaming: false,
    pendingFiles: [],
  };

  function persist() {
    save(KEYS.baseUrl, state.baseUrl);
    save(KEYS.apiKey, state.apiKey);
    save(KEYS.model, state.model);
    save(KEYS.modelsCache, state.modelsCache);
    save(KEYS.conversations, state.conversations);
    save(KEYS.currentConvId, state.currentConvId);
    save(KEYS.tokenStats, state.tokenStats);
    save(KEYS.sidebarCollapsed, state.sidebarCollapsed);
    save(KEYS.theme, state.theme);
  }

  function currentConv() {
    return state.conversations.find(c => c.id === state.currentConvId);
  }

  function newConv() {
    const conv = { id: Date.now().toString(), title: '新对话', messages: [], createdAt: Date.now(), temperature: 0.7, topP: 1, maxTokens: 4096 };
    state.conversations.unshift(conv);
    state.currentConvId = conv.id;
    persist();
    return conv;
  }

  function configured() { return state.baseUrl && state.apiKey && state.model; }

  function normalizeUrl(u) {
    u = u.replace(/\/+$/, '');
    if (!u.endsWith('/v1')) u += '/v1';
    return u;
  }

  // ===== DOM =====
  const $ = id => document.getElementById(id);

  const dom = {
    sidebar: $('sidebar'),
    sidebarToggle: $('sidebar-toggle'),
    convList: $('conv-list'),
    newChatBtn: $('new-chat-btn'),
    settingsBtn: $('settings-btn'),
    themeBtn: $('theme-btn'),
    sidebarBackdrop: $('sidebar-backdrop'),
    main: $('main'),
    header: $('header'),
    modelDropdownBtn: $('model-dropdown-btn'),
    modelDropdownList: $('model-dropdown-list'),
    currentModel: $('current-model'),
    messages: $('messages'),
    welcome: $('welcome'),
    userInput: $('user-input'),
    sendBtn: $('send-btn'),
    // Settings modal
    settingsModal: $('settings-modal'),
    modalClose: $('modal-close'),
    cfgBaseUrl: $('cfg-base-url'),
    cfgApiKey: $('cfg-api-key'),
    cfgModelSelect: $('cfg-model-select'),
    cfgRefreshModels: $('cfg-refresh-models'),
    cfgSave: $('cfg-save'),
    cfgCancel: $('cfg-cancel'),
    // Input params
    paramTemperature: $('param-temperature'),
    paramTopP: $('param-top-p'),
    paramMaxTokens: $('param-max-tokens'),
    convSettingsBtn: $('conv-settings-btn'),
    convSettingsPanel: $('conv-settings-panel'),
    convRenameInput: $('conv-rename-input'),
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
  };

  // ===== Render Functions =====
  function updateModelBadge() {
    dom.currentModel.textContent = state.model || '未配置';
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
    dom.convList.innerHTML = state.conversations.map(c => `
      <div class="conv-item ${c.id === state.currentConvId ? 'active' : ''}" data-id="${c.id}">
        <span class="conv-item-title">${esc(c.title)}</span>
        <button class="conv-item-rename" type="button" title="重命名">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
        </button>
        <button class="conv-item-delete" type="button" title="删除">&times;</button>
      </div>
    `).join('');
  }

  function updateSendBtn() {
    dom.sendBtn.disabled = !dom.userInput.value.trim() || state.isStreaming || !configured();
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

  function showToast(msg) {
    $('toast-el')?.remove();
    const el = document.createElement('div');
    el.id = 'toast-el'; el.className = 'toast'; el.textContent = msg;
    dom.main.appendChild(el);
    setTimeout(() => el.remove(), 1800);
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

      // Build content: thinking block + main content
      let contentHtml = '';
      if (!isUser && msg.reasoningContent) {
        const thinkingTimeStr = msg.reasoningTimeMs != null
          ? (msg.reasoningTimeMs >= 1000 ? (msg.reasoningTimeMs / 1000).toFixed(1) + 's' : msg.reasoningTimeMs + 'ms')
          : '';
        contentHtml += `
          <div class="thinking-block">
            <button class="thinking-toggle" type="button">
              <svg class="thinking-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              <span>思考过程</span>${thinkingTimeStr ? ` · ${thinkingTimeStr}` : ''}
            </button>
            <div class="thinking-content"><div class="msg-md">${renderMd(msg.reasoningContent)}</div></div>
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
        contentHtml += `<div class="msg-md">${renderMd(msg.content)}</div>`;
      }

      // Build meta row: timestamp + latency + tokens + model + actions
      const metaParts = [];
      if (isUser && msg.timestamp) {
        const d = new Date(msg.timestamp);
        const pad = n => String(n).padStart(2, '0');
        metaParts.push(`<span class="msg-meta-item">${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</span>`);
      }
      if (!isUser && msg.reasoningContent && msg.reasoningTimeMs != null) {
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

  // ===== Model Dropdown =====
  function renderModelDropdown() {
    dom.modelDropdownList.innerHTML = `
      <div class="model-dropdown-header">选择模型</div>
      <div class="model-dropdown-scroll">
        ${state.modelsCache.map(m => `
          <div class="model-option ${m === state.model ? 'active' : ''}" data-model="${esc(m)}">${esc(m)}</div>
        `).join('')}
      </div>
    `;
  }

  function openModelDropdown() {
    if (!configured()) return;
    renderModelDropdown();
    dom.modelDropdownList.classList.remove('hidden');
  }

  function closeModelDropdown() {
    dom.modelDropdownList.classList.add('hidden');
  }

  // ===== Fetch Models =====
  async function fetchModels(baseUrl, apiKey) {
    try {
      const url = normalizeUrl(baseUrl) + '/models';
      const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${apiKey}` } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      return (data.data || []).map(m => m.id).sort();
    } catch (e) {
      throw e;
    }
  }

  function populateSelectFromCache(selectEl) {
    selectEl.innerHTML = '';
    if (state.modelsCache.length === 0) {
      selectEl.innerHTML = '<option value="">-- 点击刷新按钮获取模型 --</option>';
      return;
    }
    state.modelsCache.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === state.model) opt.selected = true;
      selectEl.appendChild(opt);
    });
  }

  async function refreshModelsForSelect(baseUrl, apiKey, selectEl, refreshBtn) {
    if (!baseUrl || !apiKey) {
      alert('请先填写 Base URL 和 API Key');
      return;
    }
    refreshBtn.disabled = true;
    selectEl.innerHTML = '<option value="">加载中...</option>';
    try {
      const models = await fetchModels(baseUrl, apiKey);
      state.modelsCache = models;
      persist();
      populateSelectFromCache(selectEl);
      selectEl.value = state.model || models[0] || '';
    } catch (e) {
      selectEl.innerHTML = '<option value="">-- 获取失败 --</option>';
      alert('获取模型列表失败: ' + e.message);
    } finally {
      refreshBtn.disabled = false;
    }
  }

  // ===== Send Message =====
  async function sendMsg(userContent) {
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
    const apiMessages = conv.messages.map(m => {
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      return { role: m.role, content: m.content };
    });

    // Clear pending files after adding to message
    state.pendingFiles = [];
    renderFilePreview();

    state.isStreaming = true;
    dom.sendBtn.disabled = true;
    dom.userInput.disabled = true;

    addTyping();

    try {
      const reqBody = { model: state.model, messages: apiMessages, stream: true };
      reqBody.temperature = conv.temperature;
      reqBody.top_p = conv.topP;
      reqBody.max_tokens = conv.maxTokens;
      const resp = await fetch(normalizeUrl(state.baseUrl) + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.apiKey}` },
        body: JSON.stringify(reqBody),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: { message: `HTTP ${resp.status}` } }));
        throw new Error(err.error?.message || `HTTP ${resp.status}`);
      }

      removeTyping();
      const streamEls = addStreamMsg();

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';
      let reasoningContent = '';
      let buffer = '';
      let firstTokenTime = null;
      let reasoningStartTime = null;
      let reasoningEndTime = null;
      const streamStartTime = Date.now();

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
              reasoningContent += reasoningDelta;
              if (streamEls.thinkingBlock.classList.contains('hidden')) {
                streamEls.thinkingBlock.classList.remove('hidden');
                streamEls.thinkingBlock.classList.add('expanded');
              }
              streamEls.thinkingMd.innerHTML = renderMd(reasoningContent);
              dom.messages.scrollTop = dom.messages.scrollHeight;
            }

            if (contentDelta) {
              if (firstTokenTime === null) firstTokenTime = Date.now() - streamStartTime;
              if (reasoningContent && reasoningEndTime === null) {
                reasoningEndTime = Date.now();
                streamEls.thinkingBlock.classList.remove('expanded');
                const thinkingMs = reasoningEndTime - (reasoningStartTime || streamStartTime);
                streamEls.thinkingLabel.textContent = `思考过程 · ${thinkingMs >= 1000 ? (thinkingMs / 1000).toFixed(1) + 's' : thinkingMs + 'ms'}`;
              }
              assistantContent += contentDelta;
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
      conv.messages.push({ role: 'assistant', content: `**错误**: ${e.message}`, tokens: 0 });
      renderMessages();
    } finally {
      state.isStreaming = false;
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
  function showSettings() {
    dom.cfgBaseUrl.value = state.baseUrl;
    dom.cfgApiKey.value = state.apiKey;
    populateSelectFromCache(dom.cfgModelSelect);
    dom.cfgModelSelect.value = state.model;
    dom.settingsModal.classList.remove('hidden');
  }

  function hideSettings() {
    dom.settingsModal.classList.add('hidden');
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

  // ===== Event Binding =====
  // Sidebar
  dom.sidebarToggle.addEventListener('click', toggleSidebar);
  dom.sidebarBackdrop.addEventListener('click', closeSidebarMobile);
  dom.newChatBtn.addEventListener('click', () => { newConv(); updateSidebar(); renderMessages(); closeSidebarMobile(); syncConvParams(); dom.userInput.focus(); });

  // Sync params to/from current conversation
  function syncConvParams() {
    const conv = currentConv();
    if (conv) {
      dom.paramTemperature.value = conv.temperature;
      dom.paramTopP.value = conv.topP;
      dom.paramMaxTokens.value = conv.maxTokens;
      dom.convRenameInput.value = conv.title;
    }
  }

  function saveConvParams() {
    const conv = currentConv();
    if (!conv) return;
    conv.temperature = parseFloat(dom.paramTemperature.value) || 0.7;
    conv.topP = parseFloat(dom.paramTopP.value) || 1;
    conv.maxTokens = parseInt(dom.paramMaxTokens.value) || 4096;
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

  dom.convSettingsBtn.addEventListener('click', toggleConvSettings);
  dom.paramTemperature.addEventListener('change', saveConvParams);
  dom.paramTopP.addEventListener('change', saveConvParams);
  dom.paramMaxTokens.addEventListener('change', saveConvParams);
  dom.convRenameInput.addEventListener('change', saveConvParams);

  // Conversation list
  dom.convList.addEventListener('click', (e) => {
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
  dom.settingsBtn.addEventListener('click', showSettings);
  dom.modalClose.addEventListener('click', hideSettings);
  dom.cfgCancel.addEventListener('click', hideSettings);
  dom.settingsModal.querySelector('.modal-backdrop').addEventListener('click', hideSettings);

  dom.cfgRefreshModels.addEventListener('click', () => {
    refreshModelsForSelect(dom.cfgBaseUrl.value.trim(), dom.cfgApiKey.value.trim(), dom.cfgModelSelect, dom.cfgRefreshModels);
  });

  dom.cfgSave.addEventListener('click', () => {
    const b = dom.cfgBaseUrl.value.trim();
    const k = dom.cfgApiKey.value.trim();
    const m = dom.cfgModelSelect.value;
    if (!b || !k || !m) { alert('请填写所有配置项并选择模型'); return; }
    state.baseUrl = b;
    state.apiKey = k;
    state.model = m;
    persist();
    updateModelBadge();
    hideSettings();
    updateSendBtn();
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
    state.model = opt.dataset.model;
    persist();
    updateModelBadge();
    closeModelDropdown();
    updateSendBtn();
    showToast(`已切换到 ${state.model}`);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.model-dropdown')) closeModelDropdown();
    if (!e.target.closest('#conv-settings-panel') && !e.target.closest('#conv-settings-btn')) {
      dom.convSettingsPanel.classList.add('hidden');
      dom.convSettingsBtn.classList.remove('active');
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
      copyText(msg.content);
    } else if (btn.dataset.action === 'retry') {
      retryMessage(idx);
    } else if (btn.dataset.action === 'edit') {
      const text = typeof msg.content === 'string' ? msg.content : msg.content.find(p => p.type === 'text')?.text || '';
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

  // Send
  dom.sendBtn.addEventListener('click', () => {
    const text = dom.userInput.value.trim();
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

  if (configured()) {
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
    dom.userInput.focus();
  } else {
    showSetup();
  }
})();