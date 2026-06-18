(function () {
  'use strict';

  try {
    const saved = JSON.parse(localStorage.getItem('nc_theme'));
    const theme = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', theme);
  } catch {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  try {
    const mode = JSON.parse(localStorage.getItem('nc_mode'));
    const bootMode = mode === 'image' ? mode : 'chat';
    document.documentElement.setAttribute('data-boot-mode', bootMode);
    if (bootMode === 'chat') {
      const conversations = JSON.parse(localStorage.getItem('nc_conversations')) || [];
      const currentConvId = JSON.parse(localStorage.getItem('nc_current_conv_id'));
      const currentConv = conversations.find(c => c && c.id === currentConvId);
      if (!currentConv || !Array.isArray(currentConv.messages) || currentConv.messages.length === 0) {
        document.documentElement.setAttribute('data-boot-empty-chat', 'true');
      }
    }
  } catch {
    document.documentElement.setAttribute('data-boot-mode', 'chat');
    document.documentElement.setAttribute('data-boot-empty-chat', 'true');
  }

  try {
    const collapsed = JSON.parse(localStorage.getItem('nc_sidebar_collapsed'));
    if (collapsed || matchMedia('(max-width: 768px)').matches) {
      document.documentElement.setAttribute('data-boot-sidebar', 'collapsed');
    }
  } catch {
    if (matchMedia('(max-width: 768px)').matches) {
      document.documentElement.setAttribute('data-boot-sidebar', 'collapsed');
    }
  }
})();
