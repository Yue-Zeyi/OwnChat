(function () {
  'use strict';

  const CONFIG_QUERY_KEYS = ['config', 'config_b64', 'oc_config', 'oc_config_b64'];

  function cleanUrl() {
    if (!window.history?.replaceState) return;
    const url = new URL(window.location.href);
    CONFIG_QUERY_KEYS.forEach(k => url.searchParams.delete(k));
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

  function mergeUnique(...lists) {
    return Array.from(new Set(lists.flat().filter(Boolean)));
  }

  function parse(text) {
    const cfg = JSON.parse(text);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('配置必须是 JSON 对象');
    return cfg;
  }

  function summary(cfg) {
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

  function fromCurrentUrl() {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('config') || params.get('oc_config');
    const rawB64 = params.get('config_b64') || params.get('oc_config_b64');
    if (!raw && !rawB64) return null;
    return parse(rawB64 ? decodeBase64Url(rawB64) : raw);
  }

  window.OwnChatConfigImport = {
    cleanUrl,
    decodeBase64Url,
    parse,
    summary,
    maskKey,
    fromCurrentUrl,
  };
})();
