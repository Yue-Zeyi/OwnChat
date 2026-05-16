(function () {
  'use strict';

  function copyText(text, onSuccess, onFailure) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(onSuccess).catch(() => fallbackCopy(text, onSuccess, onFailure));
    } else {
      fallbackCopy(text, onSuccess, onFailure);
    }
  }

  function fallbackCopy(text, onSuccess, onFailure) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      if (typeof onSuccess === 'function') onSuccess();
    } catch {
      if (typeof onFailure === 'function') onFailure();
    }
    document.body.removeChild(ta);
  }

  function closeCopyMenus(root) {
    root?.querySelectorAll('.copy-menu.open').forEach(menu => menu.classList.remove('open'));
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  window.OwnChatUiUtils = {
    copyText,
    fallbackCopy,
    closeCopyMenus,
    downloadJson,
  };
})();
