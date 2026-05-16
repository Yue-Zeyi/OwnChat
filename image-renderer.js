(function () {
  'use strict';

  const ImageCore = window.OwnChatImageCore;
  const Tokens = window.OwnChatTokens;
  const Markdown = window.OwnChatMarkdown;

  function esc(value) {
    return Markdown.esc(value);
  }

  function renderWorkspace(selectedJob, options = {}) {
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
              <button class="msg-action-btn image-action" data-action="reuse" data-job="${esc(job.id)}" data-prompt="${esc(prompt || '')}" data-size="${esc(params.size || '')}" data-quality="${esc(params.quality || '')}" data-format="${esc(params.outputFormat || '')}" data-background="${esc(params.background || '')}" type="button" title="复用到输入框" data-tooltip="复用到输入框">${icons.edit || ''}</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderReplyMessage(job, reply, replyIndex, options = {}) {
    const defaultParams = options.defaultParams || {};
    const params = reply.params || job.params || defaultParams;
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
      ...ImageCore.imageUsageMeta(reply.usage || job.usage).map(metaText),
      metaText(ImageCore.formatDateTime(reply.durationMs ? (reply.startedAt || reply.createdAt || job.createdAt) + reply.durationMs : (reply.createdAt || job.createdAt))),
    ].filter(Boolean).join('');

    const outputs = (reply.outputs || []).map((out, index) => renderOutput(job, reply, replyIndex, out, index, options)).join('');

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
              <button class="btn-secondary image-action" data-action="edit-latest" data-job="${esc(job.id)}" data-reply="${replyIndex}" type="button">编辑</button>
              <button class="btn-secondary image-action" data-action="retry" data-job="${esc(job.id)}" data-reply="${replyIndex}" type="button">${reply.status === 'generating' ? '生成中' : '重绘'}</button>
            </div>
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
        <img src="${esc(ImageCore.dataUrlForImage(out, params.outputFormat))}" alt="${esc(job.prompt)}" loading="lazy" class="image-preview">
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
    const now = options.now || Date.now();
    const waitedMs = now - (job.startedAt || job.createdAt);
    const progress = `<div class="image-progress" data-job="${esc(job.id)}">
      <div class="image-progress-indicator">
        <div class="image-spinner"></div>
      </div>
      <div class="image-progress-body">
        <div class="image-progress-title">正在生成图片</div>
        <div class="image-progress-stats">
          <span class="image-progress-elapsed">耗时 ${ImageCore.formatDuration(waitedMs)}</span>
        </div>
        <div class="image-progress-note">正在生成，请勿关闭页面</div>
      </div>
      <button class="btn-secondary image-action image-cancel-btn" data-action="cancel" data-job="${esc(job.id)}" type="button">取消</button>
    </div>`;

    return `
      <div class="image-chat-msg ai">
        <div class="image-chat-inner">
          <div class="image-chat-avatar image-ai-avatar" aria-label="AI"></div>
          <div class="image-chat-bubble image-chat-bubble-progress">${progress}</div>
        </div>
      </div>
    `;
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
