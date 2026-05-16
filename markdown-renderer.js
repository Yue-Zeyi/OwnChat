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
