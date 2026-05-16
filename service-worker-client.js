(function () {
  'use strict';

  let registrationPromise = null;

  function canUseServiceWorker() {
    return 'serviceWorker' in navigator && window.location.protocol !== 'file:';
  }

  function register() {
    if (!canUseServiceWorker()) return Promise.resolve(null);
    if (!registrationPromise) {
      registrationPromise = navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(e => {
        console.warn('SW registration failed:', e);
        return null;
      });
    }
    return registrationPromise;
  }

  async function ensureTarget(timeoutMs = 5000) {
    if (!canUseServiceWorker()) return null;
    if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;

    const registration = await register();
    if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
    if (registration?.active) return registration.active;

    return new Promise(resolve => {
      let done = false;
      const finish = target => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
        resolve(target || navigator.serviceWorker.controller || null);
      };
      const onControllerChange = () => finish(navigator.serviceWorker.controller);
      const timer = setTimeout(() => finish(null), timeoutMs);
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
      navigator.serviceWorker.ready.then(reg => {
        finish(navigator.serviceWorker.controller || reg.active || null);
      }).catch(() => finish(null));
    });
  }

  window.OwnChatServiceWorker = {
    canUseServiceWorker,
    register,
    ensureTarget,
  };
})();
