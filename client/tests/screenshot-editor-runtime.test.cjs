const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture(result = { ok: true }, claimResult = { ok: true }) {
  const elements = new Map(), handlers = new Map(), calls = [];
  const noop = () => {};
  const ctx = new Proxy({}, { get: () => noop, set: () => true });
  let document;
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const node = {
      id, hidden: true, style: {}, dataset: {}, value: '', naturalWidth: 800, naturalHeight: 600,
      offsetWidth: 520, offsetHeight: 96, classList: { add: noop, remove: noop },
      addEventListener(name, fn) { listeners.set(name, fn); },
      dispatch(name, event = {}) { return listeners.get(name)?.({ target: node, ...event }); },
      setAttribute: noop, replaceChildren: noop, append: noop, getContext: () => ctx,
      toDataURL: () => 'data:image/png;base64,YWJj', setPointerCapture: noop, hasPointerCapture: () => false,
      focus() { document.activeElement = node; }, blur() { document.activeElement = null; },
      closest(selector) { return selector.includes('textarea') && id === 'textEditor' ? node : null; },
    };
    Object.defineProperty(node, 'src', { set() { Promise.resolve().then(() => node.onload()); } });
    elements.set(id, node); return node;
  }
  document = {
    activeElement: null, body: element('body'), documentElement: { style: { setProperty: noop } },
    getElementById: element, createElement: () => element(`created-${elements.size}`), createTextNode: (text) => text,
    querySelectorAll: () => [], querySelector: (selector) => element(selector),
    addEventListener: (name, fn) => handlers.set(name, fn),
  };
  const sandbox = {
    document, console, setTimeout: () => 1, clearTimeout: noop, requestAnimationFrame: (fn) => { fn(); return 0; },
    innerWidth: 800, innerHeight: 600, addEventListener: noop,
    screenshotAPI: { getCapture: async () => ({ dataUrl: 'data:image/png;base64,YWJj', width: 800, height: 600 }),
      claim: async () => claimResult, finish: async (args) => { calls.push(args); return result; }, cancel: async () => calls.push('cancel') },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const file of ['screenshot-model.js', 'screenshot-paint.js', 'screenshot-editor.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/screenshot', file), 'utf8'), context);
  function key(key, options = {}) { handlers.get('keydown')({ key, preventDefault: noop, target: document.activeElement || element('body'), ...options }); }
  function click(data) {
    const button = { dataset: data, blur: noop };
    handlers.get('click')({ target: { closest: () => button }, detail: 1 });
  }
  function point(name, x, y) { element('captureSurface').dispatch(name, { button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault: noop }); }
  async function load() {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    element('reselectConfirm').hidden = true;
    element('strokeWidth').value = '4'; element('textSize').value = '22'; element('mosaicSize').value = '18';
    point('pointerdown', 50, 50); point('pointerup', 450, 350);
  }
  return { context, elements, element, calls, key, click, point, load, state: () => sandbox.ScreenshotEditor.getState() };
}

test('Ctrl+S saves the selected image without completing a copy', async () => {
  const f = fixture(); await f.load(); f.key('s', { ctrlKey: true }); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, 'save');
});
test('Chinese composition Enter does not commit text or complete the screenshot', async () => {
  const f = fixture(); await f.load(); f.click({ tool: 'text' }); f.point('pointerdown', 100, 100);
  const editor = f.element('textEditor'); editor.value = '中文标注'; editor.dispatch('compositionstart');
  f.key('Enter', { isComposing: true }); f.key('b'); f.key('4');
  assert.equal(f.state().tool, 'text'); assert.equal(f.state().editingText, true); assert.equal(f.calls.length, 0);
  editor.dispatch('compositionend'); f.key('Enter');
  assert.equal(f.state().editingText, false); assert.equal(f.state().marks[0].text, '中文标注'); assert.equal(f.calls.length, 0);
});
test('Ctrl+S commits active text before saving', async () => {
  const f = fixture(); await f.load(); f.click({ tool: 'text' }); f.point('pointerdown', 100, 100);
  f.element('textEditor').value = '保存中文'; f.key('s', { ctrlKey: true }); await settle();
  assert.equal(f.state().marks[0].text, '保存中文'); assert.equal(f.calls[0].action, 'save');
});
test('failed copy preserves selection and annotations with an actionable error', async () => {
  const f = fixture({ ok: false, error: '剪贴板被占用，请重试' }); await f.load();
  f.key('c', { ctrlKey: true }); await settle();
  assert.equal(f.state().selection.width, 400); assert.equal(f.state().busy, false);
  assert.equal(f.element('editorStatus').hidden, false); assert.equal(f.element('editorStatus').textContent, '剪贴板被占用，请重试');
});
test('cancelled save leaves the editor usable', async () => {
  const f = fixture({ ok: false, cancelled: true }); await f.load(); f.click({ action: 'save' });
  await settle();
  assert.equal(f.state().selection.height, 300); assert.equal(f.state().busy, false); assert.match(f.element('editorStatus').textContent, /继续编辑/);
});
test('reselect with annotations asks before clearing and can keep the work', async () => {
  const f = fixture(); await f.load(); f.click({ tool: 'pen' }); f.point('pointerdown', 100, 100); f.point('pointerup', 150, 130);
  f.click({ action: 'reselect' }); assert.equal(f.element('reselectConfirm').hidden, false); assert.equal(f.state().marks.length, 1);
  f.click({ action: 'keep' }); assert.equal(f.state().marks.length, 1);
  f.click({ action: 'clear-reselect' }); assert.equal(f.state().marks.length, 0); assert.equal(f.state().selection, null);
  f.key('z', { ctrlKey: true }); assert.equal(f.state().marks.length, 1);
});
test('refused monitor claim restores the prior state instead of allowing an unusable selection', async () => {
  const f = fixture({ ok: true }, { ok: false, error: '请在已选择的显示器中完成截图。' });
  await f.load(); await settle();
  assert.equal(f.state().selection, null);
  assert.equal(f.element('editorStatus').textContent, '请在已选择的显示器中完成截图。');
  f.key('Enter'); await settle(); assert.equal(f.calls.length, 0);
});
