/*
 * Pet interaction, speech, animation, dragging, and cleanup. Throttle high-frequency work
 * with requestAnimationFrame and avoid transition: all.
 */

/* Convert exceptions to readable messages; retain raw error objects in the console only. */
function _humanErr(e, fallback) {
  try { console.error('[SoduWork]', e); } catch (_e) {}
  const m = String((e && e.message) || e || '');
  const detail = String((e && e.detail) || '').trim();
  if (/failed to fetch|networkerror|econn|network|fetch/i.test(m)) return fallback || '网络不太顺，稍后再试';
  if (/\b(401|403)\b|unauthor|forbid/i.test(m)) return '没权限或登录过期了';
  if (/\b404\b|not.?found/i.test(m)) return fallback || '没找到，可能已被改动';
  if (/\b413\b|too large/i.test(m)) return '文件太大了';
  if (detail) return detail.slice(0, 240);
  if ((e && e.status) && m && !/^HTTP\s+\d+$/i.test(m)) return m.slice(0, 240);
  return fallback || '操作没成功，稍后再试';
}

/* Speech bubbles. */
let bubbleTimer = null;
function petSay(msg, dur = 2800, opts) {
  const bubble = document.getElementById('petBubble');
  if (!bubble) return;
  /* Remove stale undo and open handlers before showing a new message. */
  if (bubble._undoHandler) { bubble.removeEventListener('click', bubble._undoHandler); bubble._undoHandler = null; }
  if (bubble._openHandler) { bubble.removeEventListener('click', bubble._openHandler); bubble._openHandler = null; }
  bubble.classList.remove('undoable');


  const openTask = opts && opts.taskId && typeof openDetailEntry === 'function'
    ? String(opts.taskId) : '';
  if (openTask) {
    const handler = (e) => {
      e.stopPropagation();
      bubble.removeEventListener('click', handler);
      bubble._openHandler = null;
      bubble.classList.remove('undoable', 'show');
      if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
      openDetailEntry(openTask);
    };
    bubble._openHandler = handler;
    bubble.addEventListener('click', handler);
    bubble.classList.add('undoable');   /* Reuse the clickable bubble styles. */
  }
  bubble.textContent = msg;
  // Measure the visible bubble at its natural width, then clamp its top-left position to the viewport.
  // Avoid left plus translateX(-50%): shrink-to-fit near the right edge would collapse the bubble's width.
  bubble.style.right = 'auto';
  bubble.style.transform = 'none';
  bubble.style.left = '-9999px';
  bubble.style.top = '0px';
  bubble.classList.add('show');
  const pr = pet.getBoundingClientRect();
  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  const M = 8;                                              // Viewport margin.
  let left = pr.left + pr.width / 2 - bw / 2;               // Center horizontally over the pet.
  left = Math.max(M, Math.min(left, window.innerWidth - bw - M));   // Clamp to the viewport.
  let top = pr.top - 12 - bh;                              // Prefer placement above the pet.
  if (top < M) top = pr.bottom + 12;                       // Place below when there is insufficient room above.
  bubble.style.left = left + 'px';
  bubble.style.top = top + 'px';
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubble.classList.remove('show');
    bubbleTimer = null;
  }, dur);
}

/*
 * Show a one-shot undo action for dur. The visible bubble already participates in Electron
 * hit-testing; undoable also enables DOM pointer events.
 */
function petSayUndo(msg, onUndo, dur = 6000) {
  petSay(msg, dur);
  const bubble = document.getElementById('petBubble');
  if (!bubble) return;
  if (bubble._openHandler) { bubble.removeEventListener('click', bubble._openHandler); bubble._openHandler = null; }
  bubble.classList.add('undoable');
  const handler = (e) => {
    e.stopPropagation();
    bubble.removeEventListener('click', handler);
    bubble._undoHandler = null;
    bubble.classList.remove('undoable', 'show');
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    onUndo();
  };
  bubble._undoHandler = handler;
  bubble.addEventListener('click', handler);
  /* On expiry, remove this handler and clickable styling; petSay owns the hide timer. */
  setTimeout(() => {
    if (bubble._undoHandler === handler) {
      bubble.removeEventListener('click', handler);
      bubble._undoHandler = null;
    }
    bubble.classList.remove('undoable');
  }, dur + 60);
}

/* Reaction animation. */
function petReact(type) {
  const valid = ['bounce', 'shake'];
  if (!valid.includes(type)) return;
  pet.classList.remove('bounce', 'shake');
  void pet.offsetWidth; /* Force reflow to restart the animation. */
  pet.classList.add(type);
  setTimeout(() => pet.classList.remove(type), 650);
}

/*
 * Synthesize a notification sound with a noise burst and rising triangle-wave chime.
 * cfg.mute disables playback.
 */
let _audioCtx = null;
function _actx() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { _audioCtx = null; }
  }
  return _audioCtx;
}
/* Unlock the audio context on the first user gesture for autoplay-policy compatibility. */
function _unlockAudioOnce() {
  const ctx = _actx();
  if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
}
if (typeof document !== 'undefined') {
  ['pointerdown', 'keydown'].forEach(ev =>
    document.addEventListener(ev, _unlockAudioOnce, { capture: true, passive: true }));
}
/* Synthesize the sound only after the audio context is running. */
function _synthOpenBox(ctx) {
  const t = ctx.currentTime;
  /* Opening sound: a short high-pass noise burst. */
  const len = Math.floor(ctx.sampleRate * 0.08);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const dat = buf.getChannelData(0);
  for (let i = 0; i < len; i++) dat[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
  const ns = ctx.createBufferSource(); ns.buffer = buf;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1100;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.22, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  ns.connect(hp).connect(ng).connect(ctx.destination); ns.start(t); ns.stop(t + 0.1);
  /* Two-note rising chime from C5 to G5. */
  [[523.25, 0.02], [783.99, 0.11]].forEach(([f, dly]) => {
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t + dly);
    g.gain.exponentialRampToValueAtTime(0.2, t + dly + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dly + 0.28);
    o.connect(g).connect(ctx.destination); o.start(t + dly); o.stop(t + dly + 0.3);
  });
}
function playOpenBox() {
  if (typeof cfg !== 'undefined' && cfg && cfg.mute) return;
  const ctx = _actx();
  if (!ctx) return;
  try {
    /*
     * Await resume before scheduling notes; a suspended audio timeline cannot play them.
     */
    if (ctx.state === 'suspended') {
      const p = ctx.resume();
      if (p && p.then) p.then(() => { try { _synthOpenBox(ctx); } catch (e) {} }).catch(() => {});
      else _synthOpenBox(ctx);
    } else {
      _synthOpenBox(ctx);
    }
  } catch (e) { /* Continue silently when audio is unavailable. */ }
}

/* Task reminder: two sets of three chimes, longer and louder than a notification. */
function _synthRemind(ctx) {
  const t = ctx.currentTime;
  [0, 0.55].forEach(rep => {
    [[880, 0], [659.25, 0.14], [880, 0.28]].forEach(([f, dly]) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + rep + dly);
      g.gain.exponentialRampToValueAtTime(0.3, t + rep + dly + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + rep + dly + 0.4);
      o.connect(g).connect(ctx.destination); o.start(t + rep + dly); o.stop(t + rep + dly + 0.45);
    });
  });
}
function playRemindChime() {
  if (typeof cfg !== 'undefined' && cfg && cfg.mute) return;
  const ctx = _actx();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') {
      const p = ctx.resume();
      if (p && p.then) p.then(() => { try { _synthRemind(ctx); } catch (e) {} }).catch(() => {});
      else _synthRemind(ctx);
    } else {
      _synthRemind(ctx);
    }
  } catch (e) { /* Continue silently when audio is unavailable. */ }
}

/* Blink animation. */
function blink() {
  pet.classList.add('blinking');
  setTimeout(() => pet.classList.remove('blinking'), 130);
}
let _blinkTimer = null;
function _scheduleBlink() {
  const delay = 3000 + Math.random() * 4500;
  _blinkTimer = setTimeout(() => { blink(); _scheduleBlink(); }, delay);
}

/* Set the pet position. */
function setPetPos(x, y) {
  /*
   * Move the element inside the full-screen transparent window.
   */
  pet.style.right = 'auto';
  pet.style.bottom = 'auto';
  pet.style.left = Math.round(x) + 'px';
  pet.style.top = Math.round(y) + 'px';
  cfg.hubX = Math.round(x);
  cfg.hubY = Math.round(y);
  saveCfg();
}

/*
 * Clamp out-of-bounds positions after display or viewport changes, preserving a 12px
 * margin and saving corrections. Shared by restoration and resize handling.
 */
function clampPetIntoView() {
  if (!pet) return;
  /*
   * Use getBoundingClientRect for dimensions affected by --ui-scale; offsetWidth returns
   * unscaled layout dimensions.
   */
  const pr = pet.getBoundingClientRect();
  const pw = pr.width || pet.offsetWidth || 72, ph = pr.height || pet.offsetHeight || 72;
  const maxX = window.innerWidth - pw, maxY = window.innerHeight - ph;
  let x = (cfg.hubX != null) ? cfg.hubX : (parseFloat(pet.style.left) || 0);
  let y = (cfg.hubY != null) ? cfg.hubY : (parseFloat(pet.style.top) || 0);
  let nx = x, ny = y;
  if (nx < 0 || nx > maxX) nx = Math.max(12, Math.min(nx, Math.max(12, maxX - 12)));
  if (ny < 0 || ny > maxY) ny = Math.max(12, Math.min(ny, Math.max(12, maxY - 12)));
  if (nx !== x || ny !== y) {
    pet.style.right = 'auto'; pet.style.bottom = 'auto';
    pet.style.left = nx + 'px'; pet.style.top = ny + 'px';
    cfg.hubX = nx; cfg.hubY = ny; saveCfg();
  }
}

/*
 * Shift the pet temporarily inward when the expanded ring would cross the screen edge.
 * Clear the transform on mouseleave; the invisible bridge preserves hover across the gap.
 */
function _keepRingOnScreen() {
  if (!pet) return;
  const btns = pet.querySelectorAll('.ring-btn');
  if (!btns.length) return;
  /*
   * Compute final button centers from layout coordinates and scaled ring offsets. Measuring
   * during the opening animation would underestimate their final extent.
   */
  const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
  const pcx = pet.offsetLeft + pet.offsetWidth / 2;
  const pcy = pet.offsetTop + pet.offsetHeight / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  btns.forEach(b => {
    const bs = getComputedStyle(b);
    const rx = parseFloat(bs.getPropertyValue('--rx')) || 0;
    const ry = parseFloat(bs.getPropertyValue('--ry')) || 0;
    const bcx = pcx + rx * scale, bcy = pcy + ry * scale;
    if (bcx < minX) minX = bcx; if (bcy < minY) minY = bcy;
    if (bcx > maxX) maxX = bcx; if (bcy > maxY) maxY = bcy;
  });
  const PAD = 22 * scale, M = 10;   /* Scale the 18px button radius and margin with ui-scale. */
  minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
  let dx = 0, dy = 0;
  if (minX < M) dx = M - minX; else if (maxX > window.innerWidth - M) dx = (window.innerWidth - M) - maxX;
  if (minY < M) dy = M - minY; else if (maxY > window.innerHeight - M) dy = (window.innerHeight - M) - maxY;
  pet.style.transform = (dx || dy)
    ? 'translate(' + Math.round(dx) + 'px,' + Math.round(dy) + 'px) scale(var(--ui-scale,1))'
    : '';
}

/* Dragging. */
let dragging = false;
let dragOX = 0, dragOY = 0;       /* Initial pointer coordinates. */
let dragPX = 0, dragPY = 0;       /* Initial pet coordinates. */
let dragEndTime = 0;
let _dragFrame = null;
let _pendX = 0, _pendY = 0;
let _downOnRing = false;   /* Track whether pointerdown targeted a ring action. */

function _onPetPointerDown(e) {
  if (e.button !== 0) return;
  dragOX = e.clientX;
  dragOY = e.clientY;
  const rect = pet.getBoundingClientRect();
  dragPX = rect.left;
  dragPY = rect.top;
  dragging = false;
  _downOnRing = !!(e.target && e.target.closest && e.target.closest('#petRing'));
  /*
   * Listen on document so fast movement outside the pet does not interrupt dragging. Avoid
   * pointer capture, which redirects ring clicks. Expand the overlay only when dragging
   * starts.
   */
  document.addEventListener('pointermove', _onPetPointerMove);
  document.addEventListener('pointerup', _onPetPointerUp);
  document.addEventListener('pointercancel', _onPetPointerUp);
  /* Use the default hover cursor and switch to grabbing only while pressed.
   Functional ring buttons retain click behavior instead of starting a drag. */
  if (!_downOnRing && typeof armGrabCursor === 'function') armGrabCursor(false);
  e.preventDefault();
}

function _onPetPointerMove(e) {
  if (dragOX === 0 && dragOY === 0) return; /* No active press. */
  const dx = e.clientX - dragOX;
  const dy = e.clientY - dragOY;
  if (!dragging) {
    if (dx * dx + dy * dy < 16) return; /* Ignore movement below the 4px drag threshold. */
    dragging = true;
    expandForOverlay(); /* Disable mouse passthrough when dragging starts so document continues receiving pointer events. */
    /*
     * Enter drag mode before per-frame movement to avoid rebuilding the native window region
     * every frame.
     */
    if (typeof beginOverlayDrag === 'function') beginOverlayDrag();
    pet.classList.add('dragging');
    if (typeof armGrabCursor === 'function') armGrabCursor(true);   /* Activate the drag cursor immediately once dragging starts. */
    pet.classList.remove('ring-open'); /* Hide the action ring while dragging. */
    pet.style.transform = '';          /* Clear the temporary ring offset before moving the pet. */
  }
  _pendX = dragPX + dx;
  _pendY = dragPY + dy;
  /* Throttle updates to animation frames. */
  if (_dragFrame) return;
  _dragFrame = requestAnimationFrame(() => {
    _dragFrame = null;
    /* Constrain movement to the viewport. */
    const w = pet.offsetWidth, h = pet.offsetHeight;
    _pendX = Math.max(0, Math.min(_pendX, window.innerWidth - w));
    _pendY = Math.max(0, Math.min(_pendY, window.innerHeight - h));
    setPetPos(_pendX, _pendY);
    /* Move the task area with the pet without moving the pet back from task layout. */

  });
}

/*
 * Task-area visibility participates in Electron's existing interactive hit-testing; avoid
 * unpaired overlay-depth changes for simple clicks.
 */
let _clickTimer = null;

function _onPetPointerUp(e) {
  const wasDragging = dragging;
  dragging = false;
  dragOX = dragOY = 0;
  pet.classList.remove('dragging');
  document.removeEventListener('pointermove', _onPetPointerMove);
  document.removeEventListener('pointerup', _onPetPointerUp);
  document.removeEventListener('pointercancel', _onPetPointerUp);
  /*
   * Shrink only after an actual drag to balance expandForOverlay. Shrinking before a click
   * would reenable passthrough and swallow ring actions.
   */
  if (wasDragging && typeof endOverlayDrag === 'function') endOverlayDrag();
  if (wasDragging) shrinkFromOverlay();
  if (wasDragging) {
    dragEndTime = Date.now();
    /*
     * Keep the pet visible after dragging and move the task area with it; task controls own
     * task-view visibility.
     */

  }
  /*
   * The pet body does not toggle task views. Ring actions control task visibility;
   * double-click opens notifications. Preserve _downOnRing for drag handling.
   */
  if (_dragFrame) { cancelAnimationFrame(_dragFrame); _dragFrame = null; }
}

/* Double-click opens notifications; dock actions own task and creation entry points. */
function _onPetDblClick(e) {
  if (Date.now() - dragEndTime < 350) return; /* Ignore double-click immediately after dragging. */
  if (e && e.target && e.target.closest && e.target.closest('#petRing')) return;
  /* Cancel any pending single-click timer to avoid double-click flicker. */
  if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; }
  if (typeof openNoticeEntry === 'function') openNoticeEntry();
  else if (typeof openNoticePanel === 'function') openNoticePanel();
}

/* Update pet state. */
function updatePet() {
  if (!pet) return;
  const unfinished = tasks.filter(t => t.status === 'todo' || t.status === 'doing');
  const doing = tasks.filter(t => t.status === 'doing');
  const allDone = tasks.length > 0 && unfinished.length === 0;

  const remind = cfg.remind && cfg.remind !== 'off' && unfinished.length > 0;
  const desired = new Set([allDone ? 'floaty' : 'idle']);
  if (remind) desired.add(cfg.remind === 'strong' ? 'remind-strong' : 'remind-light');
  for (const name of ['idle','floaty','bounce','shake','remind-light','remind-strong']) {
    if (pet.classList.contains(name) !== desired.has(name)) pet.classList.toggle(name, desired.has(name));
  }

  /* Rebuild the SVG when character or gender changes. */
  renderPetSVG(cfg.gender);

  /* Render lightweight branded feedback from the same authoritative task state. */
  if (typeof SoduWorkPetSkin !== 'undefined' && SoduWorkPetSkin.setState) {
    const soduWorkState = allDone ? 'complete' : (doing.length ? 'working' : (unfinished.length ? 'ready' : 'resting'));
    SoduWorkPetSkin.setState(soduWorkState);
  }

  /* Update the shadow color. */
  const ds = getPetShadowColor ? getPetShadowColor(cfg.gender) : 'rgba(0,0,0,.22)';
  const shadow = pet.querySelector('.pet-shadow');
  if (shadow && shadow.style.getPropertyValue('--remind-color') !== ds) shadow.style.setProperty('--remind-color', ds);
}

/* The task ring action toggles the task UI and sidebar while keeping the pet visible. */
function _toggleTasks() {
  cfg.tasksOn = (cfg.tasksOn === false);   /* Toggle false to true; all other values, including undefined, become false. */
  saveCfg();

  _syncSidebar();
  if (typeof petSay === 'function') petSay(cfg.tasksOn === false ? '桌面快捷栏已隐藏' : '桌面快捷栏已显示');
}
/* Restore saved position and visibility state. */
function restorePetPos() {

  /* Clear obsolete cfg.docked state so legacy edge docking cannot hide the pet. */
  if (cfg.docked) { cfg.docked = false; saveCfg(); pet.style.display = ''; }
  if (cfg.hubX != null && cfg.hubY != null) {
    pet.style.right = 'auto';
    pet.style.bottom = 'auto';
    /*
     * Correct off-screen saved positions after display changes; preserve valid positions and a
     * 12px margin.
     */
    const pw = pet.offsetWidth || 72, ph = pet.offsetHeight || 72;
    const maxX = window.innerWidth - pw, maxY = window.innerHeight - ph;
    let x = cfg.hubX, y = cfg.hubY;
    if (x < 0 || x > maxX) x = Math.max(12, Math.min(x, maxX - 12));
    if (y < 0 || y > maxY) y = Math.max(12, Math.min(y, maxY - 12));
    pet.style.left = x + 'px';
    pet.style.top = y + 'px';
    if (x !== cfg.hubX || y !== cfg.hubY) { cfg.hubX = x; cfg.hubY = y; saveCfg(); }
  }
  /* _syncSidebar() owns shortcut-dock visibility and placement. */
}

/* Bind events. */
function _bindPetEvents() {
  if (!pet) return;
  if (window.soduWorkAPI && soduWorkAPI.onOverlayWindowBlur && !window.__taskBlurBound) {
    window.__taskBlurBound = true;
    soduWorkAPI.onOverlayWindowBlur(() => {

      closeDockMore();
      const menu = document.querySelector('.ctx-menu.show');
      if (menu) menu.classList.remove('show');
      if (typeof _syncSidebar === 'function') _syncSidebar();
      /*
       * After blur parks the transparent window, report all still-visible pet and dock regions
       * so they do not remain clipped to 1x1.
       */
      if (typeof requestOverlayShapeSync === 'function') requestOverlayShapeSync(240, true);
    });
  }
  pet.addEventListener('pointerdown', _onPetPointerDown);
  /*
   * Register document pointer listeners on pointerdown so dragging continues outside the
   * pet's bounds.
   */
  pet.addEventListener('dblclick', _onPetDblClick);
  /* Prevent native image and selection dragging. */
  pet.addEventListener('dragstart', e => e.preventDefault());
  /*
   * Use mouseenter, mouseleave, and ring-open because CSS hover is unreliable during
   * transparent-window passthrough.
   */
  pet.addEventListener('mouseenter', () => {
    if (!dragging) { pet.classList.add('ring-open'); _keepRingOnScreen(); }
  });
  pet.addEventListener('mouseleave', () => {
    pet.classList.remove('ring-open');
    pet.style.transform = '';   /* Reset the temporary offset used to keep the expanded ring on screen. */
  });
}

/* Global dragend cleanup removes stale drag styles. */
document.addEventListener('dragend', () => {
  dragging = false;
  dragOX = dragOY = 0;
  if (_dragFrame) { cancelAnimationFrame(_dragFrame); _dragFrame = null; }
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  shrinkFromOverlay();
});

/*
 * Recheck bounds after startup because HiDPI viewport dimensions may settle after
 * restoration without a resize event. Valid positions remain unchanged.
 */
window.addEventListener('load', () => {
  [150, 600, 1500].forEach(ms => setTimeout(() => {
    try { clampPetIntoView(); } catch (e) {}
    /* Reposition the dock after viewport dimensions settle so edge alignment remains correct. */
    try { if (typeof _syncSidebar === 'function') _syncSidebar(); } catch (e) {}
  }, ms));
});

window.addEventListener('resize', clampPetIntoView);

/* Initialize after DOM readiness. */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    _bindPetEvents();
    _syncSidebar();
    restorePetPos();
    _scheduleBlink();
  });
} else {
  _bindPetEvents();
  _syncSidebar();
  restorePetPos();
  _scheduleBlink();
}
