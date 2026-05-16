(function () {
  'use strict';

  function normalizeUrl(u) {
    u = (u || '').trim();
    if (!u) throw new Error('Base URL 不能为空');
    if (!/^(https?:\/\/|\/)/i.test(u)) throw new Error('Base URL 需要以 http://、https:// 或 / 开头');
    u = u.replace(/\/+$/, '');
    if (!u.endsWith('/v1')) u += '/v1';
    return u;
  }

  function requestUrl(baseUrl, path) {
    return normalizeUrl(baseUrl) + path;
  }

  function describeNetworkError(err, url) {
    const msg = err?.message || String(err);
    if (!/Failed to fetch|NetworkError|Load failed|fetch/i.test(msg)) return err;
    let target = url;
    try { target = new URL(url, window.location.href).origin; } catch { /* keep raw url */ }
    const hints = [`浏览器没有拿到 ${target} 的可用响应`];
    try {
      const parsed = new URL(url, window.location.href);
      if (window.location.protocol === 'https:' && parsed.protocol === 'http:') {
        hints.push('当前页面是 HTTPS，但接口是 HTTP，浏览器会拦截混合内容');
      }
      if (parsed.origin !== window.location.origin) {
        hints.push('这是跨域请求，如 Network 面板显示 CORS 错误才需要检查 Access-Control-Allow-Origin');
      }
      if (/api\.openai\.com$/i.test(parsed.hostname)) {
        hints.push('浏览器直连 OpenAI API 容易被 CORS 拦截，建议通过本地或服务端代理转发');
      }
    } catch { /* ignore */ }
    if (window.location.protocol === 'file:') {
      hints.push('当前是 file:// 打开页面，建议用本地静态服务访问页面');
    }
    const message = `网络请求失败：${hints.join('；')}。请检查 Base URL、代理服务和浏览器控制台 Network 面板。`;
    const error = new Error(message);
    error.diagnostics = [
      `请求地址: ${url}`,
      `页面地址: ${window.location.href}`,
      `原始错误: ${msg}`,
      `排查建议: ${hints.join('；')}`,
    ].join('\n');
    return error;
  }

  function httpError(status, message, url, context = {}) {
    const error = new Error(message || `HTTP ${status}`);
    error.diagnostics = [
      `请求地址: ${url}`,
      `HTTP 状态: ${status}`,
      `错误信息: ${message || `HTTP ${status}`}`,
      `当前模式: ${context.mode || '未知'}`,
      `对话模型: ${context.chatModel || '未配置'}`,
      `绘画模型: ${context.imageModel || '未配置'}`,
    ].join('\n');
    return error;
  }

  async function apiFetch(url, options = {}) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw describeNetworkError(err, url);
    }
  }

  window.OwnChatApi = {
    normalizeUrl,
    requestUrl,
    describeNetworkError,
    httpError,
    apiFetch,
  };
})();
