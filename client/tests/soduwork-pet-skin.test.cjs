const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('SoduWork desktop pet is registered as an offline selectable skin', () => {
  const registry = read('core/skin-registry.js');
  const index = read('index.html');
  const character = read('components/pet/characters.js');
  const manager = read('components/skin-manager/skin-manager.js');

  assert.match(registry, /id:'soduwork-signature'/);
  assert.match(registry, /character:'soduwork'/);
  assert.match(registry, /palette:'signature'/);
  assert.match(index, /components\/pet\/soduwork-pet-skin\.js/);
  assert.match(character, /soduwork-shell/);
  assert.match(character, /<image href=\\"icon\.png\\"/);
  assert.match(manager, /s\.previewType === 'soduwork'/);
  assert.match(manager, /sp-soduwork-stage/);
});

test('SoduWork pet state layer exposes the four stable task states', () => {
  const classes = new Set();
  const attrs = new Map();
  const pet = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name)
    },
    setAttribute: (name, value) => attrs.set(name, value),
    getAttribute: (name) => attrs.get(name),
    removeAttribute: (name) => attrs.delete(name)
  };
  const timers = [];
  const context = {
    cfg: { _lastSkinId: 'soduwork-signature' },
    document: { getElementById: (id) => id === 'pet' ? pet : null },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    console
  };
  context.window = context;
  vm.runInNewContext(read('components/pet/soduwork-pet-skin.js'), context, { filename: 'soduwork-pet-skin.js' });
  const skin = context.SoduWorkPetSkin;

  assert.deepEqual(Object.keys(skin.STATES), ['resting', 'ready', 'working', 'complete']);
  skin.setState('working');
  assert.equal(attrs.get('data-soduwork-state'), 'working');
  assert.equal(classes.has('soduwork-state-working'), true);

  skin.setState('complete');
  assert.equal(attrs.get('data-soduwork-state'), 'complete');
  assert.equal(classes.has('soduwork-state-complete'), true);
  timers.at(-1)();
  assert.equal(attrs.get('data-soduwork-state'), 'resting');
  assert.equal(classes.has('soduwork-state-resting'), true);
  skin.setState('complete');
  assert.equal(attrs.get('data-soduwork-state'), 'resting');

  context.cfg._lastSkinId = 'box-biz';
  skin.setState('working');
  assert.equal(attrs.has('data-soduwork-state'), false);
  assert.equal([...classes].some((name) => name.startsWith('soduwork-state-')), false);
});

test('SoduWork desktop pet renders the approved local logo and task status', () => {
  const petSvg = { innerHTML: '' };
  const context = {
    cfg: { character: 'soduwork', gender: 'boy', _lastSkinId: 'soduwork-signature' },
    document: { getElementById: (id) => id === 'petSvg' ? petSvg : null },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    console
  };
  vm.runInNewContext(read('core/skin-registry.js'), context, { filename: 'skin-registry.js' });
  vm.runInNewContext(read('components/pet/characters.js'), context, { filename: 'characters.js' });
  context.renderPetSVG('boy');

  assert.match(petSvg.innerHTML, /class="soduwork-shell"/);
  assert.match(petSvg.innerHTML, /<image href="icon\.png"/);
  assert.doesNotMatch(petSvg.innerHTML, /soduwork-dot-orange/);
  assert.match(petSvg.innerHTML, /class="soduwork-status-dot"/);
});

test('repeated task updates retain the pet SVG; actual theme/character changes repaint', () => {
  let paints = 0, content = '', color = '';
  const petSvg = { get innerHTML() { return content; }, set innerHTML(value) { content = value; paints++; } };
  const context = { cfg:{character:'soduwork',gender:'boy'},
    document:{getElementById:id=>id==='petSvg'?petSvg:null},
    getComputedStyle:()=>({getPropertyValue:()=>color}), console };
  vm.runInNewContext(read('components/pet/characters.js'), context);
  for (let i=0;i<100;i++) context.renderPetSVG('boy');
  assert.equal(paints,1,'identical SVG must keep its gradients, animation nodes and pixels');
  color = '#8844aa'; context.renderPetSVG('boy'); assert.equal(paints,2);
  context.cfg.character = 'bear'; context.renderPetSVG('boy'); assert.equal(paints,3);
  context.renderPetSVG('boy'); assert.equal(paints,3);
});

test('SoduWork desktop pet resolves and displays the supplied local action frames', () => {
  const classes = new Set();
  const attrs = new Map();
  const image = {
    parentNode: null,
    complete: false,
    naturalWidth: 0,
    setAttribute: (name, value) => attrs.set(name, value),
    getAttribute: (name) => attrs.get(name)
  };
  const pet = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => force ? classes.add(name) : classes.delete(name)
    },
    setAttribute: (name, value) => attrs.set(name, value),
    getAttribute: (name) => attrs.get(name),
    removeAttribute: (name) => attrs.delete(name),
    querySelector: () => null,
    insertBefore: (node) => { node.parentNode = pet; }
  };
  const timers = [];
  const context = {
    cfg: { _lastSkinId: 'soduwork-signature' },
    document: {
      baseURI: 'file:///C:/Program%20Files/code/soduwork/client/index.html',
      getElementById: (id) => id === 'pet' ? pet : null,
      createElement: () => image
    },
    URL,
    setTimeout: (fn) => {
      const timer = { fn, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: () => {},
    console
  };
  context.window = context;
  vm.runInNewContext(read('components/pet/soduwork-pet-skin.js'), context, { filename: 'soduwork-pet-skin.js' });
  const skin = context.SoduWorkPetSkin;

  assert.equal(skin.framePaths('resting').length, 1);
  assert.equal(skin.framePaths('ready').length, 4);
  assert.equal(skin.framePaths('working').length, 7);
  skin.setState('working');
  assert.match(image.src, /assets\/pet-skins\/soduwork-actions\/working\/frame-01\.png$/);
  image.onload();
  assert.equal(classes.has('soduwork-sprite-active'), true);
  assert.equal(skin.isSpriteReady(), true);

  skin.setState('ready');
  assert.match(image.src, /assets\/pet-skins\/soduwork-actions\/ready\/frame-01\.png$/);
  image.onload();
  const readyTimer = timers.at(-1);
  assert.equal(typeof readyTimer.fn, 'function');
  readyTimer.fn();
  assert.match(image.src, /assets\/pet-skins\/soduwork-actions\/ready\/frame-02\.png$/);

  skin.destroy();
});

test('pending, failed and stale frames never hide a valid frame; hidden pets stop loading', async () => {
  const classes = new Set(), attrs = new Map(), images = [], timers = new Map(); let nextTimer = 0;
  const pet = {
    classList: { contains: key => classes.has(key), add: key => classes.add(key), remove: key => classes.delete(key),
      toggle: (key, on) => on ? classes.add(key) : classes.delete(key) },
    setAttribute: (key, value) => attrs.set(key, value), getAttribute: key => attrs.get(key), removeAttribute: key => attrs.delete(key),
    querySelector: () => null, insertBefore: image => { image.parentNode = pet; pet.image = image; },
    replaceChild: (next, old) => { assert.equal(old, pet.image); old.parentNode = null; next.parentNode = pet; pet.image = next; }
  };
  const document = { hidden: false, getElementById: () => pet, createElement: () => {
    const values = new Map(); let decode;
    const image = { setAttribute: (key, value) => values.set(key, value), getAttribute: key => values.get(key),
      decode: () => new Promise(resolve => { decode = resolve; }), decoded: () => decode() };
    images.push(image); return image;
  } };
  const context = { cfg: { _lastSkinId: 'soduwork-signature' }, document, console,
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id) };
  context.window = context;
  vm.runInNewContext(read('components/pet/soduwork-pet-skin.js'), context);
  const skin = context.SoduWorkPetSkin;
  const tick = () => { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); };
  const complete = async image => { image.onload(); await Promise.resolve(); image.decoded(); await Promise.resolve(); await Promise.resolve(); };
  skin.setState('working'); await complete(images[0]);
  assert.equal(classes.has('soduwork-sprite-active'), true);
  tick(); const pending = images.at(-1);
  assert.equal(images.length, 2); assert.equal(pet.image, images[0]);
  for (let i = 0; i < 10; i++) tick();
  assert.equal(images.length, 2, 'slow decode must not create overlapping frame requests');
  assert.equal(classes.has('soduwork-sprite-active'), true);
  await complete(pending); assert.equal(pet.image, pending);
  tick(); images.at(-1).onerror();
  assert.equal(pet.image, pending); assert.equal(classes.has('soduwork-sprite-fallback'), false);
  tick(); const stale = images.at(-1); stale.onload(); await Promise.resolve();
  context.cfg.petVisible = false; skin.sync();
  assert.equal(timers.size, 0);
  stale.decoded(); await Promise.resolve(); await Promise.resolve(); assert.equal(pet.image, pending);
  context.cfg.petVisible = true; skin.sync(); assert.equal(timers.size, 1);
  tick(); context.cfg._lastSkinId = 'box-biz'; skin.sync(); assert.equal(timers.size, 0);
  assert.equal(classes.has('soduwork-sprite-active'), false);
  skin.destroy(); assert.equal(timers.size, 0);
});

function resumablePet() {
  const classes = new Set(), attrs = new Map(), images = [], timers = new Map(); let nextTimer = 0;
  const pet = {
    classList: { contains: key => classes.has(key), add: key => classes.add(key), remove: key => classes.delete(key),
      toggle: (key, on) => on ? classes.add(key) : classes.delete(key) },
    setAttribute: (key, value) => attrs.set(key, value), getAttribute: key => attrs.get(key), removeAttribute: key => attrs.delete(key),
    querySelector: () => pet.image || null, insertBefore: image => { image.parentNode = pet; pet.image = image; },
    replaceChild: (next, old) => { assert.equal(old, pet.image); old.parentNode = null; next.parentNode = pet; pet.image = next; }
  };
  const document = { hidden: false, getElementById: () => pet, createElement: () => {
    const values = new Map();
    const image = { setAttribute: (key, value) => values.set(key, value), getAttribute: key => values.get(key) };
    images.push(image); return image;
  } };
  const context = { cfg: { _lastSkinId: 'soduwork-signature' }, document, console,
    setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; }, clearTimeout: id => timers.delete(id) };
  context.window = context;
  vm.runInNewContext(read('components/pet/soduwork-pet-skin.js'), context);
  return { context, images, timers, pet, skin: context.SoduWorkPetSkin,
    complete: () => images.at(-1).onload(), frame: () => pet.image.getAttribute('data-soduwork-frame'),
    finishCompletion() {
      const [id, timer] = [...timers].find(([, timer]) => timer.delay === 2600);
      timers.delete(id); timer.fn();
    }
  };
}

for (const hiddenBy of ['setting', 'document']) {
  function hide(f, hidden) {
    if (hiddenBy === 'setting') f.context.cfg.petVisible = !hidden;
    else f.context.document.hidden = hidden;
    f.skin.sync();
  }
  for (const next of ['resting', 'complete']) test('resuming ' + hiddenBy + ' visibility reloads an interrupted ' + next + ' frame', () => {
    const f = resumablePet(); f.skin.setState('working'); f.complete();
    f.skin.setState(next); const stale = f.images.at(-1), count = f.images.length;
    const completion = [...f.timers.keys()];
    hide(f, true); assert.equal(stale.onload, null);
    hide(f, false);
    assert.equal(f.images.length, count + 1, 'resume must request the static state frame that was cancelled');
    assert.match(f.frame(), /working\/frame-01\.png$/, 'last decoded pixels remain until replacement loads');
    f.complete(); assert.match(f.frame(), new RegExp('/' + next + '/frame-01\\.png$'));
    assert.deepEqual([...f.timers.keys()], completion, 'resume must not restart the completion deadline');
    if (next === 'complete') {
      f.finishCompletion(); f.complete();
      assert.match(f.frame(), /resting\/frame-01\.png$/);
      f.skin.sync(); assert.equal(f.pet.getAttribute('data-soduwork-state'), 'resting');
    }
    f.skin.destroy(); assert.equal(f.timers.size, 0);
  });

  test('completion ending while hidden by ' + hiddenBy + ' resumes the resting frame without replaying completion', () => {
    const f = resumablePet(); f.skin.setState('working'); f.complete();
    f.skin.setState('complete'); f.complete();
    hide(f, true); f.finishCompletion();
    assert.equal(f.pet.getAttribute('data-soduwork-state'), 'resting');
    const count = f.images.length;
    hide(f, false);
    assert.equal(f.images.length, count + 1, 'resting image skipped while hidden must load on resume');
    f.complete(); assert.match(f.frame(), /resting\/frame-01\.png$/);
    assert.equal(f.timers.size, 0, 'completed animation must not restart');
    f.skin.destroy();
  });
}

test('SoduWork sprite has restrained idle motion and no layered motion while working', () => {
  const css = read('components/pet/pet.css');
  const skin = read('components/pet/soduwork-pet-skin.js');

  assert.match(css, /@keyframes soduwork-pet-breathe/);
  assert.match(css, /\.pet\.soduwork-sprite-active\.soduwork-state-resting \.soduwork-pet-sprite\{animation:soduwork-pet-breathe/);
  assert.match(css, /\.pet\.soduwork-sprite-active\.soduwork-state-working \.soduwork-pet-sprite\{animation:none\}/);
  assert.match(css, /\.pet\.soduwork-sprite-active\.soduwork-state-complete \.soduwork-pet-sprite\{animation:soduwork-pet-complete/);
  assert.match(css, /prefers-reduced-motion:reduce[\s\S]*?\.pet\.soduwork-sprite-active \.soduwork-pet-sprite\{animation:none!important\}/);
  assert.match(skin, /!\["ready", "working"\]\.includes\(state\)/);
});
