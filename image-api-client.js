(function () {
  'use strict';

  const Api = window.OwnChatApi;
  const ImageCore = window.OwnChatImageCore;

  function authHeaders(apiKey) {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
  }

  async function parseError(resp) {
    return resp.json().catch(() => ({ error: { message: `HTTP ${resp.status}` } }));
  }

  async function requestMappedImage(endpoint, prompt, params, refs = [], signal = null) {
    const url = Api.requestUrl(endpoint.baseUrl, '/responses');
    const body = buildMappedImageBody(endpoint.model, prompt, params, refs);
    const resp = await Api.apiFetch(url, {
      method: 'POST',
      headers: authHeaders(endpoint.apiKey),
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const err = await parseError(resp);
      throw Api.httpError(resp.status, err.error?.message || `HTTP ${resp.status}`, url);
    }
    return ImageCore.parseResponseImageOutputs(await resp.json(), params.outputFormat);
  }

  async function optimizePrompt(endpoint, prompt, signal = null) {
    const lang = ImageCore.promptLanguageInstruction(prompt);
    const url = Api.requestUrl(endpoint.baseUrl, '/chat/completions');
    const resp = await Api.apiFetch(url, {
      method: 'POST',
      headers: authHeaders(endpoint.apiKey),
      body: JSON.stringify({
        model: endpoint.model,
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
      signal,
    });
    if (!resp.ok) {
      const err = await parseError(resp);
      throw Api.httpError(resp.status, err.error?.message || `HTTP ${resp.status}`, url);
    }
    return ImageCore.extractChatText(await resp.json()).replace(/^["“]|["”]$/g, '').trim();
  }

  async function requestOneImage(endpoint, model, prompt, params, signal = null) {
    const url = Api.requestUrl(endpoint.baseUrl, '/images/generations');
    const body = ImageCore.buildImageRequestBody(model, prompt, params);
    const resp = await Api.apiFetch(url, {
      method: 'POST',
      headers: authHeaders(endpoint.apiKey),
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const err = await parseError(resp);
      throw Api.httpError(resp.status, err.error?.message || `HTTP ${resp.status}`, url);
    }
    return ImageCore.parseImageOutputs(await resp.json(), params.outputFormat);
  }

  async function requestImageEdit(endpoint, model, prompt, params, refs = [], signal = null) {
    const url = Api.requestUrl(endpoint.baseUrl, '/images/edits');
    const form = buildImageEditForm(model, prompt, params, refs);
    const resp = await Api.apiFetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${endpoint.apiKey}` },
      body: form,
      signal,
    });
    if (!resp.ok) {
      const err = await parseError(resp);
      throw Api.httpError(resp.status, err.error?.message || `HTTP ${resp.status}`, url);
    }
    return ImageCore.parseImageOutputs(await resp.json(), params.outputFormat);
  }

  function buildMappedImageBody(model, prompt, params, refs = []) {
    return {
      model,
      input: ImageCore.mappedImageInput(prompt, refs),
      tools: [ImageCore.imageToolOptions(params, model)],
      tool_choice: 'required',
    };
  }

  function buildImageEditForm(model, prompt, params, refs = []) {
    const effectiveParams = ImageCore.sanitizeImageParamsForModel(model, params);
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt.trim());
    ImageCore.imageReferenceList(refs).forEach(item => {
      const refBlob = ImageCore.dataUrlToBlob(item.base64);
      form.append('image', refBlob, ImageCore.filenameForBlob(item.name, refBlob));
    });
    if (effectiveParams.size !== 'auto') form.append('size', effectiveParams.size);
    if (effectiveParams.quality !== 'auto') form.append('quality', effectiveParams.quality);
    if (effectiveParams.outputFormat && !/^dall-e/i.test(model)) form.append('output_format', effectiveParams.outputFormat);
    if (effectiveParams.background !== 'auto') form.append('background', effectiveParams.background);
    return form;
  }

  function buildServiceWorkerRequest({ imageEndpoint, mapEndpoint = null, model, mapModel, prompt, params, refs = [], jobId, startedAt, timeoutMs }) {
    const requestModel = mapModel && mapEndpoint ? mapEndpoint.model : model;
    const effectiveParams = ImageCore.sanitizeImageParamsForModel(requestModel, params);
    const headers = authHeaders(imageEndpoint.apiKey);
    const base = { type: 'start-image', jobId, startedAt, timeoutMs, outputFormat: effectiveParams.outputFormat };

    if (mapModel && mapEndpoint) {
      return Object.assign(base, {
        url: Api.requestUrl(mapEndpoint.baseUrl, '/responses'),
        headers: authHeaders(mapEndpoint.apiKey),
        body: JSON.stringify(buildMappedImageBody(mapEndpoint.model, prompt, effectiveParams, refs)),
        requestType: 'responses',
      });
    }

    if (refs.length) {
      return Object.assign(base, {
        url: Api.requestUrl(imageEndpoint.baseUrl, '/images/edits'),
        headers,
        requestType: 'edit',
        formParams: {
          model,
          prompt: prompt.trim(),
          images: refs.map(item => ({ base64: item.base64, filename: item.name })),
          size: effectiveParams.size,
          quality: effectiveParams.quality,
          outputFormat: effectiveParams.outputFormat,
          background: effectiveParams.background,
        },
      });
    }

    return Object.assign(base, {
      url: Api.requestUrl(imageEndpoint.baseUrl, '/images/generations'),
      headers,
      body: JSON.stringify(ImageCore.buildImageRequestBody(model, prompt, effectiveParams)),
      requestType: 'generations',
    });
  }

  window.OwnChatImageApi = {
    requestMappedImage,
    optimizePrompt,
    requestOneImage,
    requestImageEdit,
    buildServiceWorkerRequest,
  };
})();
