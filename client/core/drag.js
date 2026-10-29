/*
 * Shared makeDraggable(el, handle, opts) supports document pointer listeners, a 4px
 * threshold, overlay passthrough control, and viewport clamping. Convert centered
 * positioning to explicit pixels only after dragging starts; opts.exclude adds
 * non-draggable targets.
 */
(function (global) {
  'use strict';



  var BASE_EXCLUDE = 'button, a, input, textarea, select, label, [contenteditable], ' +
    '.seg, .status-pick, .tp-tabs, .ball, .kanban-card, .quad-strip';























  function isWindowMain(el) {
    if (!el || !global.__deskPanel) return false;
    /*
     * Workspace business pages use the native title bar; suppress custom dragging even before
     * a static page becomes active.
     */
    if (global.__deskPanel === 'workspace') return true;
    try {
      return getComputedStyle(el).getPropertyValue('--window-main').trim() === '1';
    } catch (_) { return false; }   /* Preserve draggable behavior when computed styles are unavailable before mounting. */
  }

  /*
   * Centralize drag cursors here: visible handles use grab on hover; other draggable targets
   * use grabbing after a sustained press or actual movement. Shared body classes override
   * descendant cursor rules.
   */
  var HOLD_MS = 160, _holdTimer = null;
  function armGrabCursor(now) {
    if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = null; }
    if (now) { document.body.classList.add('is-grabbing'); return; }
    _holdTimer = setTimeout(function () {
      _holdTimer = null;
      document.body.classList.add('is-grabbing');
    }, HOLD_MS);
  }
  function disarmGrabCursor() {
    if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = null; }
    document.body.classList.remove('is-grabbing');
  }

  /*
   * Delegate native draggable and handle events through document capture so rerendered nodes
   * remain covered. Clean up on pointer release, cancellation, dragend, drop, or blur.
   */
  document.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var t = e.target;
    if (!t || !t.closest) return;
    /* Buttons and inputs inside handles retain their own interactions. */
    if (t.closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
    if (t.closest('[draggable="true"], .drag-handle')) armGrabCursor(false);
  }, true);
  ['pointerup', 'pointercancel', 'dragend', 'drop'].forEach(function (ev) {
    document.addEventListener(ev, disarmGrabCursor, true);
  });
  global.addEventListener('blur', disarmGrabCursor);

  function makeDraggable(el, handle, opts) {
    if (!el || !handle || el._dragBound) return;
    if (isWindowMain(el)) return;
    el._dragBound = true;
    opts = opts || {};
    var exclude = BASE_EXCLUDE + (opts.exclude ? ',' + opts.exclude : '');
    /*
     * Mark only dedicated visible handles with drag-handle; whole-panel drag surfaces retain
     * ordinary content cursors.
     */
    if (handle !== el) handle.classList.add('drag-handle');

    var startX = 0, startY = 0, baseL = 0, baseT = 0, moved = false, frame = null, pendL = 0, pendT = 0;

    function onDown(e) {
      if (e.button !== 0) return;
      /* Leave interactive descendants to their own handlers. */
      if (e.target.closest && e.target.closest(exclude)) return;




      try {
        var _t = e.target;
        if (_t && _t.nodeType === 1 && getComputedStyle(_t).userSelect === 'text') return;
      } catch (_) { /* Preserve existing behavior when computed styles are unavailable. */ }
      var r = el.getBoundingClientRect();
      baseL = r.left; baseT = r.top;
      startX = e.clientX; startY = e.clientY;
      moved = false;
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);




    }

    function onMove(e) {
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved) {
        if (dx * dx + dy * dy < 16) return;   /* Ignore movement below 4px. */
        moved = true;
        /*
         * On actual drag start, clear selection and temporarily disable page selection; onUp
         * restores it.
         */
        try { var _s = window.getSelection && window.getSelection(); if (_s) _s.removeAllRanges(); } catch (_) {}
        document.body.classList.add('dragging-window');
        if (e.cancelable) e.preventDefault();
        /*
         * Convert centered positioning to fixed pixel coordinates only when dragging starts,
         * preserving automatic centering for ordinary clicks.
         */
        el.style.position = 'fixed';
        el.style.zIndex = '80';
        el.style.left = Math.round(baseL) + 'px';
        el.style.top = Math.round(baseT) + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.margin = '0';
        el.style.transform = 'none';   /* Remove centering and opening transforms to avoid applying offsets twice. */
        if (typeof expandForOverlay === 'function') expandForOverlay();
        armGrabCursor(true);   /* Activate grabbing immediately after crossing the drag threshold. */
      }
      var w = el.offsetWidth, h = el.offsetHeight;
      pendL = Math.max(0, Math.min(baseL + dx, window.innerWidth - w));
      pendT = Math.max(0, Math.min(baseT + dy, window.innerHeight - h));
      if (frame) return;
      frame = requestAnimationFrame(function () {
        frame = null;
        el.style.left = Math.round(pendL) + 'px';
        el.style.top = Math.round(pendT) + 'px';
      });
    }

    function onUp() {
      var wasMoved = moved;
      moved = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      /* Document capture listeners own cursor cleanup. */
      document.body.classList.remove('dragging-window');   /* Restore page selection. */
      if (frame) { cancelAnimationFrame(frame); frame = null; }
      if (wasMoved && typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
    }

    handle.addEventListener('pointerdown', onDown);
    /* Prevent native text and image dragging from handles. */
    handle.addEventListener('dragstart', function (e) { e.preventDefault(); });
  }

  /*
   * Bind built-in dialogs to their headers or noninteractive panel areas. Preserve explicit
   * positions after user dragging; CSS owns initial centering.
   */
  function bindBuiltins() {
    var byId = function (id) { return document.getElementById(id); };
    var settings = byId('settingsPanel'); if (settings) makeDraggable(settings, settings);
    var skin = byId('skinManager'); var skinHead = skin && skin.querySelector('.sm-head');
    if (skin && skinHead) makeDraggable(skin, skinHead);
    var team = byId('teamPanel'); var teamHead = team && team.querySelector('.tp-head');
    if (team && teamHead) makeDraggable(team, teamHead);
    var addMask = byId('addMask'); var modal = addMask && addMask.querySelector('.modal');
    var modalHead = modal && modal.querySelector('h3');
    if (modal && modalHead) makeDraggable(modal, modalHead);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindBuiltins);
  else bindBuiltins();

  /* Anchor popups to the left edge of the active task view, or the right-hand dock as a fallback.
   Use right-edge positioning and .pop-left to avoid covering the center of the workspace. */
  function placeDockPopup(el) {
    if (!el) return;
    var gap = 12;
    var anchor = document.getElementById('edgeDock');
    var vw = window.innerWidth, vh = window.innerHeight;
    el.classList.add('pop-left');
    /* Clear previous drag and positioning overrides. */
    el.style.left = 'auto'; el.style.bottom = 'auto'; el.style.margin = '0';
    el.style.position = 'fixed';
    var w = el.offsetWidth || 400, h = el.offsetHeight || 400;
    var right = 24, top = Math.max(8, (vh - h) / 2);
    if (anchor) {
      var r = anchor.getBoundingClientRect();
      right = Math.max(8, vw - r.left + gap);      /* Place the dialog's right edge one gap left of its parent. */
      top = r.top;                                  /* Align with the parent's top edge. */
    }
    if (vw - right - w < 8) right = Math.max(8, vw - w - 8);   /* Shift right when necessary to keep the dialog within the viewport. */
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    if (top < 8) top = 8;
    el.style.right = Math.round(right) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  global.makeDraggable = makeDraggable;
  global.placeDockPopup = placeDockPopup;
  /*
   * Custom drag implementations arm the held-press cursor on pointerdown and activate it
   * after crossing the threshold. Shared document listeners handle cleanup.
   */
  global.armGrabCursor = armGrabCursor;
  global.disarmGrabCursor = disarmGrabCursor;
})(typeof window !== 'undefined' ? window : this);
