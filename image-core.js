(function () {
  'use strict';

  function imageReferenceList(refs, maxRefs = Infinity) {
    const list = Array.isArray(refs) ? refs.slice() : (refs ? [refs] : []);
    return list.filter(ref => ref?.base64).slice(0, maxRefs);
  }

  function imageReferencePayload(refs, maxRefs = Infinity) {
    return imageReferenceList(refs, maxRefs).map(ref => ({
      name: ref.name,
      type: ref.type,
      base64: ref.base64,
    }));
  }

  function imageJobReplies(job) {
    if (!job) return [];
    return Array.isArray(job.replies) ? job.replies : [];
  }

  function ensureImageJobReplies(job) {
    if (!job) return [];
    if (!Array.isArray(job.replies)) job.replies = [];
    return job.replies;
  }

  function currentImageActiveReply(job) {
    const replies = ensureImageJobReplies(job);
    return replies.find(reply => reply.status === 'generating') || replies[replies.length - 1] || null;
  }

  function imageReplyOutput(job, replyIndex, outputIndex) {
    const reply = imageJobReplies(job)[Number.isFinite(replyIndex) ? replyIndex : 0];
    return {
      reply,
      out: reply?.outputs?.[Number.isFinite(outputIndex) ? outputIndex : 0],
    };
  }

  function normalizeImageFormat(format) {
    const value = (format || '').toLowerCase().replace(/^image\//, '');
    if (value === 'jpg') return 'jpeg';
    return value || '';
  }

  function normalizeImageModel(model) {
    return (model || '').trim().toLowerCase();
  }

  function imageModelDisallowsTransparentBackground(model) {
    return /(?:^|[/:])gpt-image-2(?:$|[-_.])/.test(normalizeImageModel(model));
  }

  function imageBackgroundSupported(model, background) {
    return background !== 'transparent' || !imageModelDisallowsTransparentBackground(model);
  }

  function sanitizeImageParamsForModel(model, params = {}) {
    const next = Object.assign({}, params);
    if (!imageBackgroundSupported(model, next.background)) next.background = 'auto';
    if (next.background === 'transparent' && normalizeImageFormat(next.outputFormat) === 'jpeg') {
      next.outputFormat = 'png';
    }
    return next;
  }

  function dataUrlForImage(out, fallbackFormat) {
    if (!out) return '';
    const format = normalizeImageFormat(out.format || fallbackFormat || 'png') || 'png';
    if (out.url) {
      const sanitizeUrl = window.OwnChatMarkdown?.sanitizeUrl || (url => url);
      return sanitizeUrl(out.url, { image: true });
    }
    return `data:image/${format};base64,${out.b64 || ''}`;
  }

  function imageByteSize(out) {
    if (Number.isFinite(out?.bytes)) return out.bytes;
    if (!out?.b64) return 0;
    const clean = out.b64.replace(/\s/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
  }

  function imageOutputMeta(out, fallbackFormat) {
    const size = out?.width && out?.height ? `${out.width}x${out.height}` : '尺寸读取中';
    const format = normalizeImageFormat(out?.format || fallbackFormat || '') || '未知格式';
    const bytes = window.OwnChatAttachments?.formatBytes?.(imageByteSize(out)) || '大小未知';
    return [size, format.toUpperCase(), bytes].filter(Boolean);
  }

  function normalizeImageUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.input);
    const output = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.output);
    const total = Number(usage.total_tokens ?? usage.total);
    const imageInput = Number(usage.input_tokens_details?.image_tokens ?? usage.input_image_tokens ?? usage.details?.inputImage);
    const textInput = Number(usage.input_tokens_details?.text_tokens ?? usage.input_text_tokens ?? usage.details?.inputText);
    const imageOutput = Number(usage.output_tokens_details?.image_tokens ?? usage.output_image_tokens ?? usage.details?.outputImage);
    const textOutput = Number(usage.output_tokens_details?.text_tokens ?? usage.output_text_tokens ?? usage.details?.outputText);
    const normalized = {};
    if (Number.isFinite(input)) normalized.input = input;
    if (Number.isFinite(output)) normalized.output = output;
    if (Number.isFinite(total)) normalized.total = total;
    const details = {};
    if (Number.isFinite(imageInput)) details.inputImage = imageInput;
    if (Number.isFinite(textInput)) details.inputText = textInput;
    if (Number.isFinite(imageOutput)) details.outputImage = imageOutput;
    if (Number.isFinite(textOutput)) details.outputText = textOutput;
    if (Object.keys(details).length) normalized.details = details;
    return Object.keys(normalized).length ? normalized : null;
  }

  function imageUsageMeta(usage) {
    const normalized = normalizeImageUsage(usage);
    if (!normalized) return [];
    const formatCount = value => window.OwnChatTokens?.formatTokenCount?.(value) || String(value);
    const primary = Number.isFinite(normalized.total)
      ? normalized.total
      : (Number.isFinite(normalized.output) ? normalized.output : normalized.input);
    if (!Number.isFinite(primary)) return [];
    const parts = [];
    if (Number.isFinite(normalized.input)) parts.push(`输入 ${formatCount(normalized.input)}`);
    if (Number.isFinite(normalized.output)) parts.push(`输出 ${formatCount(normalized.output)}`);
    if (Number.isFinite(normalized.total)) parts.push(`总计 ${formatCount(normalized.total)}`);
    return [{
      text: `Tokens ${formatCount(primary)}`,
      title: parts.join(' / '),
    }];
  }

  function imageResponseResult(outputs, usage = null) {
    return {
      outputs: Array.isArray(outputs) ? outputs : [],
      usage: normalizeImageUsage(usage),
    };
  }

  function imageResultOutputs(result) {
    if (Array.isArray(result)) return result;
    return Array.isArray(result?.outputs) ? result.outputs : [];
  }

  function imageResultUsage(result) {
    return normalizeImageUsage(result?.usage);
  }

  function safeFileStem(value, fallback, maxLength = 60) {
    return (value || fallback).replace(/[\\/:*?"<>|]+/g, '-').slice(0, maxLength) || fallback;
  }

  function imageFilename(job, out) {
    const ext = out?.format || job?.params?.outputFormat || 'png';
    return `${safeFileStem(job?.title, 'ownchat-image')}.${ext}`;
  }

  function attachmentImageFilename(item) {
    const fallback = `attachment.${item?.format || 'png'}`;
    return safeFileStem(item?.name, fallback, 80);
  }

  function imageViewerItemsForJob(job, scope = 'outputs', maxRefs = Infinity) {
    if (!job) return [];
    const items = [];
    imageJobReplies(job).forEach((reply, replyIndex) => {
      if (scope === 'inputs') {
        imageReferencePayload(reply.inputImages || job.inputImages, maxRefs).forEach((inputImage, refIndex) => {
          const format = (inputImage.type || '').replace(/^image\//, '') || (reply.params || job.params)?.outputFormat || 'png';
          items.push({
            jobId: job.id,
            inputRef: true,
            inputImage,
            replyIndex,
            refIndex,
            src: inputImage.base64,
            out: { b64: inputImage.base64.split(',').pop(), format },
          });
        });
      }
      if (scope !== 'outputs') return;
      (reply.outputs || []).forEach((output, index) => {
        items.push({
          jobId: job.id,
          replyIndex,
          index,
          src: dataUrlForImage(output, (reply.params || job.params)?.outputFormat),
          out: output,
        });
      });
    });
    return items;
  }

  function estimateImageSeconds(params = {}, refs = []) {
    const qualityFactor = params.quality === 'high' ? 130 : params.quality === 'medium' ? 95 : params.quality === 'low' ? 60 : 90;
    const sizeFactor = params.size === '3840x2160' || params.size === '2160x3840'
      ? 95
      : params.size === '1536x1024' || params.size === '1024x1536'
        ? 35
        : params.size === 'auto' ? 15 : 20;
    const editFactor = (Array.isArray(refs) ? refs.length > 0 : !!refs) ? 35 : 0;
    return Math.max(60, qualityFactor + sizeFactor + editFactor);
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const restSeconds = seconds % 60;
    return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  }

  function formatDateTime(ts) {
    const date = new Date(ts || Date.now());
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function imageTimeoutMs(params, refs = []) {
    return Math.max(30 * 60 * 1000, estimateImageSeconds(params, refs) * 1000 * 3);
  }

  function imageStaleTimeoutMs() {
    return 10 * 60 * 1000;
  }

  function imageJobDuration(job, activeReply, startedAt = null) {
    return Date.now() - (startedAt || activeReply?.startedAt || job?.startedAt || job?.createdAt || Date.now());
  }

  function setImageJobDone(job, activeReply, outputs, startedAt = null, usage = null) {
    const normalizedUsage = normalizeImageUsage(usage);
    activeReply.outputs = outputs;
    activeReply.usage = normalizedUsage;
    activeReply.error = null;
    activeReply.status = 'done';
    activeReply.durationMs = imageJobDuration(job, activeReply, startedAt);
    job.outputs = outputs;
    job.usage = normalizedUsage;
    job.error = null;
    job.status = 'done';
    job.durationMs = activeReply.durationMs;
  }

  function setImageJobFailed(job, activeReply, message, status = 'error', startedAt = null) {
    const isCancelled = status === 'cancelled';
    activeReply.error = message || (isCancelled ? '请求已中断' : '生成失败');
    activeReply.status = isCancelled ? 'cancelled' : 'error';
    activeReply.durationMs = imageJobDuration(job, activeReply, startedAt);
    job.error = activeReply.error;
    job.status = activeReply.status;
    job.durationMs = activeReply.durationMs;
  }

  function completeImageJobFromSession(job, activeReply, session, startedAt) {
    const nextOutputs = window.OwnChatDb?.parseImageSessionOutputs?.(session) || [];
    if (nextOutputs.length === 0) {
      setImageJobFailed(job, activeReply, '接口未返回可显示的图片数据', 'error', startedAt);
    } else {
      setImageJobDone(job, activeReply, nextOutputs, startedAt, session?.usage);
    }
  }

  function failImageJobFromSession(job, activeReply, message, status = 'error', startedAt = null) {
    setImageJobFailed(job, activeReply, message, status, startedAt);
  }

  function parseImageOutputs(data, format) {
    const outputs = (data.data || []).map(item => ({
      b64: item.b64_json || '',
      url: item.url || '',
      revisedPrompt: item.revised_prompt || '',
      format: normalizeImageFormat(item.output_format || item.mime_type || format),
      bytes: item.b64_json ? imageByteSize({ b64: item.b64_json }) : 0,
      createdAt: Date.now(),
    })).filter(item => item.b64 || item.url);
    return imageResponseResult(outputs, data.usage);
  }

  function parseResponseImageOutputs(data, format) {
    const outputs = [];
    const scan = value => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(scan);
        return;
      }
      if (typeof value !== 'object') return;
      if ((value.type === 'image_generation_call' || value.type === 'image_generation') && value.result) {
        outputs.push({
          b64: value.result,
          url: '',
          revisedPrompt: '',
          format: normalizeImageFormat(value.output_format || value.mime_type || format),
          bytes: imageByteSize({ b64: value.result }),
          createdAt: Date.now(),
        });
      }
      Object.keys(value).forEach(key => scan(value[key]));
    };
    scan(data.output || data);
    return imageResponseResult(outputs, data.usage || data.response?.usage);
  }

  function imageToolOptions(params = {}, model = '') {
    const effectiveParams = sanitizeImageParamsForModel(model, params);
    const opts = { type: 'image_generation' };
    if (effectiveParams.size !== 'auto') opts.size = effectiveParams.size;
    if (effectiveParams.quality !== 'auto') opts.quality = effectiveParams.quality;
    if (effectiveParams.outputFormat) opts.output_format = effectiveParams.outputFormat;
    if (effectiveParams.background !== 'auto') opts.background = effectiveParams.background;
    return opts;
  }

  function mappedImageInput(prompt, refs) {
    const list = imageReferenceList(refs);
    if (!list.length) return prompt.trim();
    return [{
      role: 'user',
      content: [
        { type: 'input_text', text: prompt.trim() },
        ...list.map(item => ({ type: 'input_image', image_url: item.base64 })),
      ],
    }];
  }

  function buildImageRequestBody(model, prompt, params = {}) {
    const effectiveParams = sanitizeImageParamsForModel(model, params);
    const body = {
      model,
      prompt: prompt.trim(),
      n: 1,
    };
    if (effectiveParams.size !== 'auto') body.size = effectiveParams.size;
    if (effectiveParams.quality !== 'auto') body.quality = effectiveParams.quality;
    if (effectiveParams.outputFormat && !/^dall-e/i.test(model)) body.output_format = effectiveParams.outputFormat;
    if (effectiveParams.background !== 'auto') body.background = effectiveParams.background;
    return body;
  }

  function extractChatText(data) {
    const msg = data?.choices?.[0]?.message;
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content.trim();
    if (Array.isArray(msg.content)) {
      return msg.content.map(part => part.text || '').join('').trim();
    }
    return '';
  }

  function promptLanguageInstruction(prompt) {
    const cjkCount = (prompt.match(/[\u3400-\u9fff]/g) || []).length;
    const latinCount = (prompt.match(/[a-zA-Z]/g) || []).length;
    if (cjkCount > 0 && cjkCount >= latinCount * 0.3) {
      return {
        label: '中文',
        instruction: '用户原提示词主要是中文，优化结果必须使用中文输出。不要翻译成英文，不要中英混写，除非原文中的品牌名、专有名词或参数本身是英文。',
      };
    }
    return {
      label: '原文语言',
      instruction: '优化结果必须使用用户原提示词的主要语言输出。不要擅自切换语言；只有原文是英文时才输出英文。',
    };
  }

  function dataUrlToBlob(dataUrl) {
    const [header, data] = dataUrl.split(',');
    const mime = header.match(/data:([^;]+)/)?.[1] || 'image/png';
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function filenameForBlob(name, blob) {
    const ext = blob.type.includes('jpeg') ? 'jpg' : blob.type.includes('webp') ? 'webp' : 'png';
    const base = (name || 'reference').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60);
    return `${base || 'reference'}.${ext}`;
  }

  function createImageReply({ jobId, prompt, params, refs, startedAt, model, mapModel, replyId = `${jobId}-reply-${Date.now()}` }) {
    const inputImages = imageReferencePayload(refs);
    return {
      id: replyId,
      model,
      mapModel,
      prompt: prompt.trim(),
      inputImages,
      params: Object.assign({}, params),
      outputs: [],
      error: null,
      status: 'generating',
      startedAt,
      createdAt: startedAt,
      estimatedSeconds: estimateImageSeconds(params, inputImages),
      durationMs: null,
      usage: null,
    };
  }

  window.OwnChatImageCore = {
    imageReferenceList,
    imageReferencePayload,
    imageJobReplies,
    ensureImageJobReplies,
    currentImageActiveReply,
    imageReplyOutput,
    dataUrlForImage,
    imageByteSize,
    normalizeImageFormat,
    normalizeImageModel,
    imageModelDisallowsTransparentBackground,
    imageBackgroundSupported,
    sanitizeImageParamsForModel,
    imageOutputMeta,
    normalizeImageUsage,
    imageUsageMeta,
    imageResponseResult,
    imageResultOutputs,
    imageResultUsage,
    imageFilename,
    attachmentImageFilename,
    imageViewerItemsForJob,
    estimateImageSeconds,
    formatDuration,
    formatDateTime,
    imageTimeoutMs,
    imageStaleTimeoutMs,
    imageJobDuration,
    setImageJobDone,
    setImageJobFailed,
    completeImageJobFromSession,
    failImageJobFromSession,
    parseImageOutputs,
    parseResponseImageOutputs,
    imageToolOptions,
    mappedImageInput,
    buildImageRequestBody,
    extractChatText,
    promptLanguageInstruction,
    dataUrlToBlob,
    filenameForBlob,
    createImageReply,
  };
})();
