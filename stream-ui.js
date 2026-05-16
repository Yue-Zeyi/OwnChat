(function () {
  'use strict';

  const Markdown = window.OwnChatMarkdown;
  const ChatRenderer = window.OwnChatChatRenderer;

  let streamRafPending = false;
  let streamRafCallbacks = new Map();

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
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function removeTyping(doc = document) {
    doc.getElementById('typing-el')?.remove();
  }

  function addStreamMsg(messagesEl, aiAvatar) {
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
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return {
      thinkingMd: el.querySelector('.thinking-content .msg-md'),
      thinkingBlock: el.querySelector('.thinking-block'),
      thinkingLabel: el.querySelector('.thinking-label'),
      contentMd: el.querySelector('.chat-msg-body > .msg-md'),
      waiting: el.querySelector('.stream-waiting'),
    };
  }

  function updateStream(messagesEl, el, text) {
    scheduleStreamRender(() => {
      el.innerHTML = Markdown.renderMd(text);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }, el);
  }

  function renderStreamContent(messagesEl, streamEls, content, opts = {}) {
    scheduleStreamRender(() => {
      if (opts.hideWaiting !== false) streamEls.waiting?.classList.add('hidden');
      streamEls.contentMd.innerHTML = Markdown.renderMd(content);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }, streamEls?.contentMd || streamEls);
  }

  function showThinkingContent(messagesEl, streamEls, reasoningContent, opts = {}) {
    if (!streamEls?.thinkingBlock || !reasoningContent || opts.showThinking === false) return;
    scheduleStreamRender(() => {
      streamEls.waiting?.classList.add('hidden');
      streamEls.thinkingBlock.classList.remove('hidden');
      if (opts.resetUserToggle) delete streamEls.thinkingBlock.dataset.userToggled;
      if (opts.expanded !== false && streamEls.thinkingBlock.dataset.userToggled !== 'true') {
        streamEls.thinkingBlock.classList.add('expanded');
      }
      streamEls.thinkingMd.innerHTML = Markdown.renderMd(reasoningContent);
      if (opts.label) streamEls.thinkingLabel.textContent = opts.label;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }, streamEls.thinkingMd);
  }

  function updateThinkingStream(messagesEl, streamEls, reasoningContent, reasoningStartTime, streamStartTime, showThinking) {
    if (!showThinking || !reasoningContent) return;
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
      messagesEl.scrollTop = messagesEl.scrollHeight;
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
    updateStream,
    renderStreamContent,
    showThinkingContent,
    updateThinkingStream,
    finishThinkingStream,
    hideEmptyThinkingStream,
    applyThinkingDoneLabel,
  };
})();
