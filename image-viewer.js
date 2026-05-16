(function () {
  'use strict';

  let dom = null;
  let callbacks = {};
  let mounted = false;
  let viewer = null;
  let transform = { scale: 1, x: 0, y: 0 };
  let dragging = null;
  let touch = null;

  function mount(elements, opts = {}) {
    dom = elements;
    callbacks = opts || {};
    if (mounted) return;
    mounted = true;

    dom.closeBtn?.addEventListener('click', close);
    dom.backdrop?.addEventListener('click', close);
    dom.prevBtn?.addEventListener('click', () => switchImage(-1));
    dom.nextBtn?.addEventListener('click', () => switchImage(1));
    dom.img?.addEventListener('wheel', zoom, { passive: false });
    dom.img?.addEventListener('pointerdown', startDrag);
    dom.viewer?.addEventListener('pointermove', moveDrag);
    dom.viewer?.addEventListener('pointerup', endDrag);
    dom.viewer?.addEventListener('pointercancel', endDrag);
    dom.img?.addEventListener('dblclick', resetTransform);
    dom.img?.addEventListener('touchstart', startTouch, { passive: false });
    dom.img?.addEventListener('touchmove', moveTouch, { passive: false });
    dom.img?.addEventListener('touchend', endTouch);
    dom.img?.addEventListener('touchcancel', endTouch);
    dom.copyBtn?.addEventListener('click', () => callbacks.onCopy?.(current()));
    dom.downloadBtn?.addEventListener('click', () => callbacks.onDownload?.(current()));
    document.addEventListener('keydown', handleKeydown);
  }

  function openItems(items, itemIndex = 0) {
    viewer = {
      items: Array.isArray(items) ? items : [],
      itemIndex: Math.max(0, itemIndex),
    };
    resetTransform();
    sync();
    dom.viewer.classList.remove('hidden');
  }

  function openAttachment(item) {
    viewer = Object.assign({ attachment: true }, item);
    resetTransform();
    sync();
    dom.viewer.classList.remove('hidden');
  }

  function close() {
    dom.viewer.classList.add('hidden');
    dom.img.src = '';
    viewer = null;
    dragging = null;
    touch = null;
    dom.counter.textContent = '';
    dom.counter.classList.add('hidden');
    dom.prevBtn.classList.add('hidden');
    dom.nextBtn.classList.add('hidden');
  }

  function isOpen() {
    return !!dom?.viewer && !dom.viewer.classList.contains('hidden');
  }

  function current() {
    if (!viewer) return null;
    if (viewer.attachment) return viewer;
    if (!Array.isArray(viewer.items)) return null;
    return viewer.items[viewer.itemIndex || 0] || null;
  }

  function sync() {
    if (!viewer) return;
    if (viewer.attachment) {
      dom.img.src = viewer.src;
      dom.counter.textContent = '';
      dom.counter.classList.add('hidden');
      dom.prevBtn.classList.add('hidden');
      dom.nextBtn.classList.add('hidden');
      return;
    }
    if (!Array.isArray(viewer.items)) return;
    const total = viewer.items.length;
    const itemIndex = Math.min(Math.max(viewer.itemIndex || 0, 0), Math.max(total - 1, 0));
    viewer.itemIndex = itemIndex;
    const item = viewer.items[itemIndex];
    if (item) dom.img.src = item.src;
    dom.counter.textContent = total > 1 ? `${itemIndex + 1} / ${total}` : '';
    dom.counter.classList.toggle('hidden', total <= 1);
    dom.prevBtn.classList.toggle('hidden', total <= 1);
    dom.nextBtn.classList.toggle('hidden', total <= 1);
  }

  function switchImage(direction) {
    if (!viewer || !Array.isArray(viewer.items) || viewer.items.length <= 1) return;
    const total = viewer.items.length;
    viewer.itemIndex = (viewer.itemIndex + direction + total) % total;
    resetTransform();
    sync();
  }

  function clampScale(scale) {
    return Math.min(8, Math.max(0.25, scale));
  }

  function applyTransform() {
    const t = transform;
    dom.img.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
    dom.img.classList.toggle('is-zoomed', t.scale > 1.01);
  }

  function resetTransform() {
    transform = { scale: 1, x: 0, y: 0 };
    dragging = null;
    applyTransform();
  }

  function zoom(e) {
    if (!isOpen()) return;
    e.preventDefault();
    const nextScale = clampScale(transform.scale * (e.deltaY < 0 ? 1.16 : 1 / 1.16));
    if (Math.abs(nextScale - transform.scale) < 0.001) return;

    const rect = dom.img.getBoundingClientRect();
    const cx = e.clientX - (rect.left + rect.width / 2);
    const cy = e.clientY - (rect.top + rect.height / 2);
    const ratio = nextScale / transform.scale;
    transform = {
      scale: nextScale,
      x: transform.x - cx * (ratio - 1),
      y: transform.y - cy * (ratio - 1),
    };
    applyTransform();
  }

  function startDrag(e) {
    if (!isOpen()) return;
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    e.preventDefault();
    dragging = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: transform.x,
      originY: transform.y,
    };
    dom.img.setPointerCapture?.(e.pointerId);
    dom.viewer.classList.add('is-panning');
  }

  function moveDrag(e) {
    if (!dragging || dragging.pointerId !== e.pointerId) return;
    e.preventDefault();
    transform.x = dragging.originX + e.clientX - dragging.startX;
    transform.y = dragging.originY + e.clientY - dragging.startY;
    applyTransform();
  }

  function endDrag(e) {
    if (!dragging || dragging.pointerId !== e.pointerId) return;
    e.preventDefault();
    dragging = null;
    dom.img.releasePointerCapture?.(e.pointerId);
    dom.viewer.classList.remove('is-panning');
  }

  function touchDistance(touches) {
    const [a, b] = touches;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function touchCenter(touches) {
    const [a, b] = touches;
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  function startTouch(e) {
    if (!isOpen() || e.touches.length !== 2) return;
    e.preventDefault();
    touch = {
      distance: touchDistance(e.touches),
      center: touchCenter(e.touches),
      scale: transform.scale,
      x: transform.x,
      y: transform.y,
    };
  }

  function moveTouch(e) {
    if (!touch || e.touches.length !== 2) return;
    e.preventDefault();
    const center = touchCenter(e.touches);
    transform = {
      scale: clampScale(touch.scale * (touchDistance(e.touches) / touch.distance)),
      x: touch.x + center.x - touch.center.x,
      y: touch.y + center.y - touch.center.y,
    };
    applyTransform();
  }

  function endTouch(e) {
    if (e.touches.length < 2) touch = null;
  }

  function handleKeydown(e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      switchImage(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      switchImage(1);
    }
  }

  window.OwnChatImageViewer = {
    mount,
    openItems,
    openAttachment,
    close,
    current,
    switchImage,
    resetTransform,
    isOpen,
  };
})();
