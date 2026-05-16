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
