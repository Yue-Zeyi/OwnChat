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
