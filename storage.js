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
