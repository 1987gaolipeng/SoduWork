/* Keep draft menus inside both the viewport and their clipping containers. */
(function (global) {
  'use strict';
  function position(host) {
    const popup = host && host.querySelector('.cp-sel.open .cp-selpop');
    const button = popup && popup.parentElement.querySelector('.cp-selbtn');
    if (!button) return;
    const visible = { top: 0, left: 0, bottom: global.innerHeight, right: global.innerWidth };
    for (let node = popup.parentElement; node; node = node.parentElement) {
      const style = global.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        visible.top = Math.max(visible.top, rect.top + node.clientTop);
        visible.bottom = Math.min(visible.bottom, rect.top + node.clientTop + node.clientHeight);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        visible.left = Math.max(visible.left, rect.left + node.clientLeft);
        visible.right = Math.min(visible.right, rect.left + node.clientLeft + node.clientWidth);
      }
    }
    const bounds = button.getBoundingClientRect();
    const margin = 8, gap = 5;
    const above = Math.max(0, bounds.top - visible.top - margin - gap);
    const below = Math.max(0, visible.bottom - bounds.bottom - margin - gap);
    popup.style.maxHeight = '370px';
    popup.style.left = '0';
    popup.style.maxWidth = Math.max(0, visible.right - visible.left - margin * 2) + 'px';
    const height = Math.min(370, popup.scrollHeight + 2);
    const up = below < height && above > below;
    popup.style.top = up ? 'auto' : 'calc(100% + 5px)';
    popup.style.bottom = up ? 'calc(100% + 5px)' : 'auto';
    popup.style.maxHeight = Math.min(370, up ? above : below) + 'px';
    const rect = popup.getBoundingClientRect();
    const offset = Math.max(visible.left + margin - rect.left,
      Math.min(0, visible.right - margin - rect.right));
    popup.style.left = offset + 'px';
  }
  global.ComposeSelectionPosition = Object.freeze({ position });
})(window);
