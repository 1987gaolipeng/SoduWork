(function () {
  'use strict';
  const M = window.ScreenshotModel, P = window.ScreenshotPaint, api = window.screenshotAPI;
  const $ = (id) => document.getElementById(id);
  const surface = $('captureSurface'), image = $('desktopImage'), canvas = $('annotationCanvas');
  const selectionElement = $('selection'), toolbar = $('toolbar'), textEditor = $('textEditor');
  const hint = $('captureHint'), status = $('editorStatus');
  const toolNames = { select: '移动选区', rect: '矩形', ellipse: '椭圆', arrow: '箭头', pen: '画笔', text: '文字', mosaic: '马赛克' };
  let state = { selection: null, marks: [] }, history = M.createHistory(state);
  let ready = false, busy = false, drag = null, textDraft = null, composing = false;
  let tool = 'select', color = '#ed4747', pendingMark = null, frame = 0, statusTimer = 0;
  let toolbarPosition = null, toolbarDrag = null;
  const scaleX = () => image.naturalWidth / window.innerWidth;
  const scaleY = () => image.naturalHeight / window.innerHeight;
  const toView = (rect) => ({ x: rect.x / scaleX(), y: rect.y / scaleY(), width: rect.width / scaleX(), height: rect.height / scaleY() });
  const point = (event) => ({ x: M.clamp(event.clientX * scaleX(), 0, image.naturalWidth), y: M.clamp(event.clientY * scaleY(), 0, image.naturalHeight) });
  const inside = (p, r) => r && p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;
  function position(element, rect) {
    Object.assign(element.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }
  function announce(message, persistent = false) {
    clearTimeout(statusTimer); status.textContent = message; status.hidden = !message;
    if (!persistent) statusTimer = setTimeout(() => { status.hidden = true; }, 4500);
  }
  function setHint(message) {
    hint.replaceChildren(document.createTextNode(message));
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.dataset.action = 'cancel'; cancel.textContent = '取消';
    hint.append(cancel);
  }
  function refreshOptions() {
    document.querySelectorAll('[data-tool]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.tool === tool)));
    document.querySelectorAll('[data-color]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.color === color)));
    $('activeToolName').textContent = toolNames[tool];
    $('colorOptions').hidden = tool === 'select' || tool === 'mosaic';
    $('strokeControl').hidden = ['select', 'text', 'mosaic'].includes(tool);
    $('textControl').hidden = tool !== 'text'; $('mosaicControl').hidden = tool !== 'mosaic';
    surface.style.cursor = tool === 'select' && state.selection ? 'move' : tool === 'text' ? 'text' : 'crosshair';
    document.querySelector('[data-action="undo"]').disabled = !history.canUndo();
    document.querySelector('[data-action="redo"]').disabled = !history.canRedo();
    document.querySelector('[data-action="reselect"]').title = state.marks.length ? '重新框选（清除当前标注）' : '重新框选';
  }
  function draw() {
    frame = 0;
    if (!ready) return;
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
    P.paint(ctx, pendingMark ? state.marks.concat(pendingMark) : state.marks, image, state.selection);
    const vw = window.innerWidth, vh = window.innerHeight;
    const rect = state.selection ? toView(state.selection) : { x: 0, y: 0, width: 0, height: 0 };
    selectionElement.hidden = !state.selection;
    position($('shadeTop'), { x: 0, y: 0, width: vw, height: rect.y });
    position($('shadeLeft'), { x: 0, y: rect.y, width: rect.x, height: rect.height });
    position($('shadeRight'), { x: rect.x + rect.width, y: rect.y, width: vw - rect.x - rect.width, height: rect.height });
    position($('shadeBottom'), { x: 0, y: rect.y + rect.height, width: vw, height: vh - rect.y - rect.height });
    if (state.selection) {
      position(selectionElement, rect);
      const bounds = M.cropBounds(state.selection, image.naturalWidth, image.naturalHeight);
      $('selectionSize').textContent = `${bounds.width} × ${bounds.height}`;
      $('selectionSize').style.top = rect.y < 32 ? '6px' : '-30px';
    }
    toolbar.hidden = !state.selection || Boolean(drag);
    hint.hidden = Boolean(state.selection);
    refreshOptions();
    if (!toolbar.hidden) {
      const pos = toolbarPosition ? { x: M.clamp(toolbarPosition.x, 8, Math.max(8, vw - toolbar.offsetWidth - 8)), y: M.clamp(toolbarPosition.y, 8, Math.max(8, vh - toolbar.offsetHeight - 8)) } : M.toolbarPosition(rect, toolbar.offsetWidth, toolbar.offsetHeight, vw, vh);
      toolbar.style.left = `${pos.x}px`; toolbar.style.top = `${pos.y}px`;
    }
  }
  function requestDraw() { if (!frame) frame = requestAnimationFrame(draw); }
  function commitState() { state = history.push(state); requestDraw(); }
  function chooseTool(next) {
    commitText(); tool = next; status.hidden = true; requestDraw();
  }
  function startText(p) {
    const fontSize = Number($('textSize').value) * scaleY();
    const rect = state.selection;
    const x = M.clamp(p.x, rect.x, Math.max(rect.x, rect.x + rect.width - 20 * scaleX()));
    const y = M.clamp(p.y, rect.y, Math.max(rect.y, rect.y + rect.height - fontSize * 1.3));
    textDraft = { type: 'text', x, y, size: fontSize, color, text: '' };
    textEditor.value = ''; textEditor.style.color = color; textEditor.style.fontSize = `${fontSize / scaleY()}px`;
    position(textEditor, { x: x / scaleX(), y: y / scaleY(), width: Math.max(20, (rect.x + rect.width - x) / scaleX()), height: Math.min((rect.y + rect.height - y) / scaleY(), fontSize * 2.6 / scaleY()) });
    textEditor.hidden = false; textEditor.focus();
    announce('Enter 确认文字，Shift+Enter 换行');
  }
  function commitText() {
    if (!textDraft || composing) return false;
    const value = textEditor.value.replace(/\r\n/g, '\n');
    if (value.trim()) { state.marks.push({ ...textDraft, text: value }); commitState(); }
    textDraft = null; textEditor.hidden = true; textEditor.value = ''; return true;
  }
  function discardText() { textDraft = null; textEditor.hidden = true; textEditor.value = ''; requestDraw(); }
  function reselect(force = false) {
    commitText();
    if (state.marks.length && !force) { $('reselectConfirm').hidden = false; document.querySelector('[data-action="keep"]').focus(); return; }
    $('reselectConfirm').hidden = true; state = { selection: null, marks: [] }; toolbarPosition = null; commitState(); tool = 'select';
    setHint('拖动选择截图范围 · Esc 取消');
  }
  function historyStep(redo) {
    if (textDraft) commitText();
    state = redo ? history.redo() : history.undo(); pendingMark = null; requestDraw();
  }
  async function cancel() {
    try { await api.cancel(); } catch (error) { announce(`无法关闭截图：${error.message || error}`, true); }
  }
  async function finish(action) {
    if (busy || !ready || !state.selection || composing) return;
    commitText(); busy = true; document.body.classList.add('busy');
    try {
      const dataUrl = P.exportPng(image, state.selection, state.marks);
      const result = await api.finish({ action, dataUrl });
      if (result && result.cancelled) announce('已取消保存，可继续编辑。');
      else if (!result || !result.ok) announce(result?.error || '截图未完成，请重试。', true);
    } catch (error) { announce(`截图未完成：${error.message || error}`, true); }
    finally { busy = false; document.body.classList.remove('busy'); }
  }
  function pointerDown(event) {
    if (!ready || busy || event.button !== 0 || !$('reselectConfirm').hidden || composing) return;
    const p = point(event), before = history.current(), handle = event.target.dataset.handle;
    commitText();
    if (handle && state.selection) drag = { type: 'resize', handle, start: p, before: history.current() };
    else if (!state.selection) {
      drag = { type: 'selection', start: p, before }; state.selection = M.rectangle(p, p, image.naturalWidth, image.naturalHeight);
      Promise.resolve().then(() => api.claim()).then((result) => {
        if (result?.ok === false) throw new Error(result.error || '请在已选择的显示器中完成截图。');
      }).catch((error) => {
        state = before; history = M.createHistory(before); drag = null; pendingMark = null;
        if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
        requestDraw(); announce(error.message || '无法切换截图屏幕，请重试。', true);
      });
    } else if (!inside(p, state.selection)) { announce('点击工具栏的“重新框选”可重新选择范围。'); return; }
    else if (tool === 'select') drag = { type: 'move', start: p, before: history.current() };
    else if (tool === 'text') { startText(p); return; }
    else {
      pendingMark = { type: tool, color, width: Number($('strokeWidth').value) * scaleX(), x: p.x, y: p.y, endX: p.x, endY: p.y };
      if (tool === 'pen') pendingMark.points = [p];
      if (tool === 'mosaic') pendingMark.block = Number($('mosaicSize').value) * scaleX();
      drag = { type: 'mark', start: p, before: history.current() };
    }
    event.preventDefault(); surface.setPointerCapture(event.pointerId); requestDraw();
  }
  function pointerMove(event) {
    if (!drag) return;
    const p = point(event);
    if (drag.type === 'selection') state.selection = M.rectangle(drag.start, p, image.naturalWidth, image.naturalHeight);
    else if (drag.type === 'resize') state.selection = M.resize(drag.before.selection, drag.handle, p, image.naturalWidth, image.naturalHeight, 4 * Math.max(scaleX(), scaleY()));
    else if (drag.type === 'move') {
      state.selection = M.move(drag.before.selection, p.x - drag.start.x, p.y - drag.start.y, image.naturalWidth, image.naturalHeight);
      state.marks = M.translateMarks(drag.before.marks, state.selection.x - drag.before.selection.x, state.selection.y - drag.before.selection.y);
    } else if (pendingMark) {
      const r = state.selection;
      const end = { x: M.clamp(p.x, r.x, r.x + r.width), y: M.clamp(p.y, r.y, r.y + r.height) };
      pendingMark.endX = end.x; pendingMark.endY = end.y;
      if (pendingMark.points && pendingMark.points.length < 5000) pendingMark.points.push(end);
    }
    requestDraw();
  }
  function pointerUp(event) {
    if (!drag) return;
    pointerMove(event);
    if (drag.type === 'selection' && (state.selection.width < 4 * scaleX() || state.selection.height < 4 * scaleY())) state = drag.before;
    if (pendingMark) {
      if (pendingMark.type === 'pen' || Math.abs(pendingMark.endX - pendingMark.x) + Math.abs(pendingMark.endY - pendingMark.y) > 2 * scaleX()) state.marks.push(pendingMark);
      pendingMark = null;
    }
    drag = null;
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    commitState();
  }
  surface.addEventListener('pointerdown', pointerDown);
  surface.addEventListener('pointermove', pointerMove);
  surface.addEventListener('pointerup', pointerUp);
  surface.addEventListener('pointercancel', () => { if (drag) { state = drag.before; drag = null; pendingMark = null; requestDraw(); } });
  surface.addEventListener('contextmenu', (event) => { event.preventDefault(); cancel(); });
  $('toolbarGrip').addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || busy) return;
    event.preventDefault();
    toolbarDrag = { x: event.clientX, y: event.clientY, left: toolbar.offsetLeft, top: toolbar.offsetTop };
    $('toolbarGrip').setPointerCapture(event.pointerId);
  });
  $('toolbarGrip').addEventListener('pointermove', (event) => {
    if (!toolbarDrag) return;
    toolbarPosition = { x: toolbarDrag.left + event.clientX - toolbarDrag.x, y: toolbarDrag.top + event.clientY - toolbarDrag.y };
    requestDraw();
  });
  $('toolbarGrip').addEventListener('pointerup', () => { toolbarDrag = null; });
  $('toolbarGrip').addEventListener('pointercancel', () => { toolbarDrag = null; });
  document.querySelectorAll('svg').forEach((svg) => { if (!svg.hasAttribute('viewBox')) svg.setAttribute('viewBox', '0 0 24 24'); });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button'); if (!button || button.disabled || busy) return;
    if (event.detail > 0) button.blur();
    if (button.dataset.tool) chooseTool(button.dataset.tool);
    if (button.dataset.color) { color = button.dataset.color; if (textDraft) { textDraft.color = color; textEditor.style.color = color; } requestDraw(); }
    const action = button.dataset.action;
    if (action === 'undo' || action === 'redo') historyStep(action === 'redo');
    if (action === 'reselect' || action === 'clear-reselect') reselect(action === 'clear-reselect');
    if (action === 'keep') $('reselectConfirm').hidden = true;
    if (action === 'save' || action === 'copy') finish(action);
    if (action === 'cancel') cancel();
  });
  textEditor.addEventListener('compositionstart', () => { composing = true; });
  textEditor.addEventListener('compositionend', () => { composing = false; });
  textEditor.addEventListener('input', () => {
    if (!textDraft) return;
    textEditor.style.height = 'auto';
    textEditor.style.height = `${Math.min(textEditor.scrollHeight + 2, (state.selection.y + state.selection.height - textDraft.y) / scaleY())}px`;
  });
  document.addEventListener('keydown', (event) => {
    if (event.isComposing || composing || event.keyCode === 229 || event.repeat || busy) return;
    const modified = event.ctrlKey || event.metaKey;
    if (!$('reselectConfirm').hidden) {
      if (event.key === 'Escape') { event.preventDefault(); $('reselectConfirm').hidden = true; }
      return;
    }
    if (modified && event.key.toLowerCase() === 's') { event.preventDefault(); finish('save'); return; }
    if (document.activeElement === textEditor) {
      if (event.key === 'Escape') { event.preventDefault(); discardText(); }
      else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); commitText(); }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    else if (event.target.closest('select,input,textarea')) return;
    else if (modified && event.key.toLowerCase() === 'z') { event.preventDefault(); historyStep(event.shiftKey); }
    else if (modified && event.key.toLowerCase() === 'y') { event.preventDefault(); historyStep(true); }
    else if (event.key === 'Enter' && !event.target.closest('button')) { event.preventDefault(); finish('copy'); }
    else if (modified && event.key.toLowerCase() === 'c') { event.preventDefault(); finish('copy'); }
  });
  window.addEventListener('resize', () => { commitText(); requestDraw(); });
  window.ScreenshotEditor = Object.freeze({
    getState: () => JSON.parse(JSON.stringify({ ...state, tool, ready, busy, editingText: Boolean(textDraft) })),
    exportPng: () => state.selection ? P.exportPng(image, state.selection, state.marks) : null,
  });
  async function initialize() {
    try {
      if (!api || typeof api.getCapture !== 'function') throw new Error('截图服务不可用，请关闭后重新截图。');
      const capture = await api.getCapture();
      if (!capture || typeof capture.dataUrl !== 'string' || !capture.dataUrl.startsWith('data:image/png;base64,')) throw new Error('未获取到屏幕图像，请重试。');
      if (!M.validImage(capture.width, capture.height)) throw new Error('屏幕图像尺寸超出支持范围。');
      const themeColor = typeof capture.theme === 'string' ? capture.theme : capture.theme?.accent;
      if (/^#[\da-f]{6}$/i.test(themeColor || '')) document.documentElement.style.setProperty('--accent', themeColor);
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('无法读取屏幕图像。')); image.src = capture.dataUrl; });
      if (!M.validImage(image.naturalWidth, image.naturalHeight)) throw new Error('屏幕图像尺寸超出支持范围。');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      ready = true; setHint('拖动选择截图范围 · Esc 取消'); draw();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (typeof api.ready === 'function') await api.ready();
    } catch (error) { setHint('截图未能启动'); announce(error.message || String(error), true); }
  }
  initialize();
})();
