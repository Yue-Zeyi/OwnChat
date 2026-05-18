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
  const DEFAULT_IMAGE_PARAMS = { size: 'auto', quality: 'auto', outputFormat: 'png', background: 'auto' };
  const MAX_IMAGE_REFS = 4;

  const state = {
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
    state.imageDefaults = sanitizeCurrentImageParams();
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
    dom.configImportModal.classList.remove('hidden');
  }

  function hideConfigImportConfirm() {
    state.pendingImportConfig = null;
    dom.configImportModal.classList.add('hidden');
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

  function sanitizeCurrentImageParams(params = state.imageDefaults) {
    return ImageCore.sanitizeImageParamsForModel(effectiveImageRequestModel(), Object.assign({}, DEFAULT_IMAGE_PARAMS, params || {}));
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

    dom.messages.scrollTop = dom.messages.scrollHeight;
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
        navigator.serviceWorker.controller.postMessage({ type: 'stop-stream' });
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
    dom.settingsModal.classList.remove('hidden');
    updateStorageStats();
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
    state.imageDefaults = sanitizeCurrentImageParams();
    dom.imageSize.value = state.imageDefaults.size;
    dom.imageQuality.value = state.imageDefaults.quality;
    dom.imageFormat.value = state.imageDefaults.outputFormat;
    dom.imageBackground.value = state.imageDefaults.background;
    syncImageBackgroundSupport();
  }

  function saveImageParams() {
    state.imageDefaults = sanitizeCurrentImageParams({
      size: dom.imageSize.value,
      quality: dom.imageQuality.value,
      outputFormat: dom.imageFormat.value,
      background: dom.imageBackground.value,
    });
    dom.imageFormat.value = state.imageDefaults.outputFormat;
    dom.imageBackground.value = state.imageDefaults.background;
    syncImageBackgroundSupport();
    persist();
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
    dom.imageEmpty.classList.toggle('hidden', !!selected);
    dom.imageGallery.innerHTML = ImageRenderer.renderWorkspace(selected, {
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
          try { swTarget.postMessage({ type: 'stop-image', status }); } catch { /* ignore */ }
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
        swTarget.postMessage(swData);

        const handleImageSession = async session => {
          if (!session || (session.jobId && session.jobId !== job.id)) return false;
          if (session.status === 'complete') {
            completeImageJobFromSession(job, activeReply, session, startedAt);
            if (refs.length) { setImageReferences([]); renderImageRefPreview(); }
            showToast(job.status === 'done' ? '图片已生成' : '生成失败');
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
        // === Fallback: no SW, direct fetch ===
        timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
        const imageResult = state.imageMapModel
          ? await ImageApi.requestMappedImage(imageMapEndpoint(), prompt, params, refs, controller.signal)
          : refs.length
            ? await ImageApi.requestImageEdit({ baseUrl: effectiveImageBaseUrl(), apiKey: effectiveImageApiKey() }, state.imageModel, prompt, params, refs, controller.signal)
            : await ImageApi.requestOneImage({ baseUrl: effectiveImageBaseUrl(), apiKey: effectiveImageApiKey() }, state.imageModel, prompt, params, controller.signal);
        const nextOutputs = ImageCore.imageResultOutputs(imageResult);
        if (nextOutputs.length === 0) throw new Error('接口未返回可显示的图片数据');
        setImageJobDone(job, activeReply, nextOutputs, startedAt, ImageCore.imageResultUsage(imageResult));
        if (refs.length) { setImageReferences([]); renderImageRefPreview(); }
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
      setImageReferences([]);
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
        dom.messages.scrollTop = dom.messages.scrollHeight;

        state.chatAbortController = { abort: () => {
          navigator.serviceWorker.controller.postMessage({ type: 'stop-stream' });
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
          renderStreamContent(state.streamEls, c);
        }
        if (conversationShowThinking(conv) && r) {
          showThinkingContent(state.streamEls, r);
        }
        dom.messages.scrollTop = dom.messages.scrollHeight;
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
      state.imageDefaults = sanitizeCurrentImageParams();
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
      state.imageDefaults = sanitizeCurrentImageParams();
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
      state.imageDefaults = Object.assign({}, DEFAULT_IMAGE_PARAMS, job.params || {}, {
        size: btn.dataset.size || job.params?.size || DEFAULT_IMAGE_PARAMS.size,
        quality: btn.dataset.quality || job.params?.quality || DEFAULT_IMAGE_PARAMS.quality,
        outputFormat: btn.dataset.format || job.params?.outputFormat || DEFAULT_IMAGE_PARAMS.outputFormat,
        background: btn.dataset.background || job.params?.background || DEFAULT_IMAGE_PARAMS.background,
      });
      state.imageDefaults = sanitizeCurrentImageParams();
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
      dom.messages.scrollTop = dom.messages.scrollHeight;
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
        scheduleStreamRender(() => {
          recoveryEls.waiting?.classList.add('hidden');
          recoveryEls.thinkingMd.innerHTML = renderMd(msg.reasoningContent);
          recoveryEls.thinkingLabel.textContent = msg.content?.trim() ? '思考过程' : '正在恢复思考过程...';
          if (msg.content?.trim()) recoveryEls.thinkingBlock?.classList.remove('expanded');
          recoveryEls.contentMd.innerHTML = renderMd(msg.content);
          dom.messages.scrollTop = dom.messages.scrollHeight;
        });
      } else {
        scheduleStreamRender(() => {
          if (conversationShowThinking(conv)) {
            recoveryEls.waiting?.classList.add('hidden');
            if ((msg.content || '').trim()) hideEmptyThinkingStream(recoveryEls);
          } else {
            recoveryEls.waiting?.classList.toggle('hidden', !!(msg.content || '').trim());
          }
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
    if (session.status === 'complete') {
      completeImageJobFromSession(job, activeReply, session);
    } else if (session.status === 'stopped') {
      setImageJobFailed(job, activeReply, '请求已中断', 'cancelled');
    } else if (session.status === 'error') {
      setImageJobFailed(job, activeReply, session.error || '生成失败');
    } else if (session.status === 'timeout') {
      setImageJobFailed(job, activeReply, '生成超时');
    }
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
      if (activeReply) activeReply.status = 'generating';
      const recoveredStartedAt = session.startedAt || activeReply?.startedAt || job.startedAt || job.createdAt || Date.now();
      const recoveredTimeoutMs = Math.max(
        Number(session.timeoutMs) || 0,
        imageTimeoutMs(activeReply?.params || job.params || state.imageDefaults),
      );
      const stopRecoveredSwImage = async () => {
        try {
          const target = await ensureServiceWorkerTarget(1000);
          target?.postMessage({ type: 'stop-image', status: 'timeout' });
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
