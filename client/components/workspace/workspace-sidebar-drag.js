/* One delegated drag controller for recent, pinned and project conversations. */
(function (global) {
  'use strict';
  function install({ root, find, move }) {
    const scroller = root.querySelector('#wsSideScroll');
    let source = '', target = null, before = '', marker = null, y = 0, frame = 0, suppressUntil = 0;
    function clearTarget() {
      target?.classList.remove('is-drop-target');
      marker?.classList.remove('is-drop-before', 'is-drop-after');
      target = null; marker = null; before = '';
    }
    function stop() {
      clearTarget(); source = ''; root.classList.remove('is-chat-dragging');
      root.querySelectorAll('[data-chat-dragging]').forEach(el => delete el.dataset.chatDragging);
      cancelAnimationFrame(frame); frame = 0;
    }
    function scroll() {
      if (!source) return;
      // Let Chromium capture the source before revealing an empty pinned group.
      // Changing the scroll layout inside dragstart cancels native drags on Windows.
      root.classList.add('is-chat-dragging');
      const box = scroller.getBoundingClientRect();
      if (y >= box.top && y <= box.bottom) {
        const edge = 36;
        const speed = y < box.top + edge ? -Math.ceil((box.top + edge - y) / 4)
          : y > box.bottom - edge ? Math.ceil((y - box.bottom + edge) / 4) : 0;
        if (speed) scroller.scrollTop += speed;
      }
      frame = requestAnimationFrame(scroll);
    }
    root.addEventListener('dragstart', event => {
      const row = event.target.closest('.ws-chat-row');
      if (!row || event.target.closest('.ws-chat-actions') || row.draggable !== true) return;
      const id = row.querySelector('.ws-chat')?.dataset.chatId;
      if (!id || !find(id) || !event.dataTransfer) return;
      source = id;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-soduwork-sidebar-chat', id);
      event.dataTransfer.setData('text/plain', row.querySelector('.ws-chat-title').textContent);
      row.dataset.chatDragging = '1';
      y = event.clientY; frame = requestAnimationFrame(scroll);
    });
    root.addEventListener('dragover', event => {
      if (!source) return;
      y = event.clientY;
      const zone = event.target.closest('[data-sidebar-section]');
      clearTarget();
      if (!zone) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
      target = zone; target.classList.add('is-drop-target');
      const row = event.target.closest('.ws-chat-row');
      if (!row || row.dataset.chatDragging) return;
      marker = row;
      const box = row.getBoundingClientRect(), lower = y > box.top + box.height / 2;
      marker.classList.add(lower ? 'is-drop-after' : 'is-drop-before');
      const next = lower ? row.nextElementSibling?.querySelector('.ws-chat') : row.querySelector('.ws-chat');
      before = next?.dataset.chatId || '';
    });
    root.addEventListener('drop', event => {
      if (!source) return;
      event.preventDefault(); event.stopPropagation();
      const id = source, zone = event.target.closest('[data-sidebar-section]');
      const destination = zone?.dataset.sidebarSection, beforeId = zone === target ? before : '';
      suppressUntil = Date.now() + 300; stop();
      if (destination) move(id, destination, beforeId);
    });
    root.addEventListener('dragend', () => { suppressUntil = Date.now() + 300; stop(); });
    root.addEventListener('dragleave', event => {
      if (!root.contains(event.relatedTarget)) { clearTarget(); y = -1; }
    });
    root.addEventListener('click', event => {
      if (Date.now() < suppressUntil && event.target.closest('.ws-chat-row')) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }, true);
    global.addEventListener('blur', stop);
    global.addEventListener('keydown', event => { if (event.key === 'Escape' && source) stop(); });
    return { stop };
  }
  global.WorkspaceSidebarDrag = { install };
})(window);
