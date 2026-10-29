'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const tick = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };

function fixture() {
  const frames = new Map(), listeners = new Map(), requests = [], editors = [], materializations = [], states = [];
  let nextFrame = 0, ref = 'session-a', scope = 'account-a', current;
  const node = () => ({ dataset: {}, setAttribute() {}, replaceChildren() { this.innerHTML = ''; }, classList: { toggle() {}, remove() {} } });
  const window = { URL, console, document: { activeElement: null },
    requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(name, handler) { (listeners.get(name) || listeners.set(name, []).get(name)).push(handler); },
    ChatWorkspaceSplit: { DEFAULT: 0.5, set() {}, bind: () => ({ dispose() {} }) },
    SoduWorkAPI: { taskStorageKey: () => scope },
    CodeMirror: { fromTextArea(area) { const instance = { getValue: () => area.value, on() {}, toTextArea() {} }; editors.push(area.value); return instance; } },
    soduWorkAPI: { workPreview: {
      onState(fn) { states.push(fn); return () => {}; }, hide: async () => ({}), destroy: async () => ({}),
      async show(payload) { requests.push(payload); return { ok: true }; },
    }, conversationSession: {} },
  };
  const sandbox = vm.createContext({ window, URL, setTimeout: () => 1, clearTimeout() {} });
  for (const name of ['chat-output-links', 'chat-dom-patch', 'panels-chat-tools', 'chat-workspace-info', 'chat-workspace-controls', 'panels-chat-workspace']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', name + '.js'), 'utf8'), sandbox);
  }
  window.ChatOutputLinks.materializeTask = file => { const request = deferred(); materializations.push({ file, ...request }); return request.promise; };
  const wb = window.ChatWorkbench;
  const makeRoot = () => {
    const events = new Map(), body = { ...node(), innerHTML: '' }, tabs = { ...node(), innerHTML: '' }, textarea = { value: '' };
    const nodes = { '.ncw': node(), '.ncw-tabs': tabs, '.ncw-body': body,
      '[data-wb-native]': { ...node(), getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }) },
      '[data-code-editor]': { querySelector: () => textarea } };
    const root = { ...node(), offsetParent: {}, querySelector: selector => nodes[selector] || null,
      addEventListener(name, fn) { events.set(name, fn); } };
    return { root, body, tabs, textarea, events };
  };
  const bind = () => { current = makeRoot(); wb.bind(current.root, () => ({ ref })); };
  bind();
  const click = (attribute, dataset = {}) => {
    const button = { ...node(), dataset, hasAttribute: name => name === attribute,
      closest: selector => selector === '.ncw-markdown a' ? null : button };
    current.events.get('click')({ target: button, preventDefault() {}, stopPropagation() {} });
  };
  return { window, wb, requests, editors, frames, states, materializations, click,
    get current() { return current; },
    async flush() { while (frames.size) { const batch = [...frames.values()]; frames.clear(); for (const fn of batch) await fn(); } await tick(); },
    switch(nextRef = 'session-b') { wb.reset(); ref = nextRef; bind(); },
    account(next) { scope = next; for (const handler of listeners.get('soduwork-data-scope-changed') || []) handler(); },
    task(file = { artifactId: 'remote-a', taskId: 'task-a', attachmentId: 'file-a', name: 'report.html', kind: 'website' }) {
      wb.render(current.root, { messages: [] }, [file]); wb.openOutput(file.artifactId); return file;
    },
  };
}

test('queued native state from the previous session cannot rename or repopulate its replacement tab', async () => {
  const f = fixture(); f.wb.openLink('https://old.example.test'); await f.flush();
  const oldId = f.requests.at(-1).tabId;
  f.switch(); f.wb.openLink('https://new.example.test'); await f.flush();
  const newId = f.requests.at(-1).tabId;
  f.states.at(-1)({ tabId: oldId, title: 'OLD PRIVATE DOCUMENT', url: 'https://old.example.test/private' });
  f.wb.toggle(); f.wb.toggle();
  assert.notEqual(oldId, newId);
  assert.doesNotMatch(f.current.tabs.innerHTML, /OLD PRIVATE DOCUMENT/);
  assert.match(f.current.tabs.innerHTML, /new.example.test/);
});

test('a pending editor animation frame cannot put previous-session text into the new session editor', async () => {
  const f = fixture();
  f.wb.openPath('old.js', { readSnapshot: { id: 'old', text: 'OLD PRIVATE SOURCE' } });
  const oldFrames = [...f.frames.values()];
  f.switch(); f.wb.openPath('new.js', { readSnapshot: { id: 'new', text: 'NEW SOURCE' } });
  await f.flush();
  for (const frame of oldFrames) await frame();
  assert.equal(f.current.textarea.value, 'NEW SOURCE');
  assert.equal(f.editors.includes('OLD PRIVATE SOURCE'), false);
});

test('a slow task preview respects manual close and does not reactivate the pane', async () => {
  const f = fixture(); f.task();
  f.wb.openLink('https://chosen.example.test'); f.click('data-wb-close');
  f.materializations[0].resolve({ artifactId: 'materialized-a', name: 'report.html', path: 'C:/a/report.html' });
  await tick();
  assert.equal(f.wb.state().open, false);
});

test('a slow task preview does not replace a newer selected file or browser', async () => {
  const f = fixture(); f.task(); f.wb.openLink('https://chosen.example.test');
  f.materializations[0].resolve({ artifactId: 'materialized-a', name: 'report.html', path: 'C:/a/report.html' });
  await tick(); await f.flush();
  assert.equal(f.requests.at(-1).url, 'https://chosen.example.test');
});

test('switching away from a pending task frees the next session to open the same attachment', async () => {
  const f = fixture(); const file = f.task(); f.switch(); f.task(file);
  assert.equal(f.materializations.length, 2);
  f.materializations[0].resolve({ artifactId: 'old-local', name: 'old.html', path: 'C:/old/report.html' });
  await tick(); assert.equal(f.wb.state().has, false);
  f.materializations[1].resolve({ artifactId: 'new-local', name: 'new.html', path: 'C:/new/report.html' });
  await tick(); await f.flush();
  assert.match(f.current.tabs.innerHTML, /new.html/); assert.doesNotMatch(f.current.tabs.innerHTML, /old.html/);
});

test('changing account invalidates visible previews and pending results without waiting for chat navigation', async () => {
  const f = fixture(); f.task(); f.wb.openLink('https://private.example.test');
  f.account('account-b');
  assert.equal(f.wb.state().has, false); assert.equal(f.wb.state().open, false);
  assert.equal(f.current.tabs.innerHTML, ''); assert.equal(f.current.body.innerHTML, '');
  f.materializations[0].resolve({ artifactId: 'old-local', name: 'old.html', path: 'C:/old/report.html' });
  await tick(); assert.equal(f.wb.state().has, false);
});

test('a current image deliverable opens in the right workbench and respects later manual choices', () => {
  const f = fixture();
  const image = { artifactId: 'image-a', name: 'result.png', relative: 'result.png',
    primary: true, changedInTurn: true, at: 1 };
  const snapshot = { messages: [{ role: 'user', blocks: [{ kind: 'text', text: 'Generate an image' }] },
    { role: 'assistant', blocks: [{ kind: 'text', text: '![Result](result.png)' }] }] };
  f.wb.render(f.current.root, snapshot, [image]);
  assert.equal(f.wb.state().open, true, 'a generated image belongs in the right preview');
  assert.match(f.current.body.innerHTML, /ncw-image/);
  assert.match(f.current.tabs.innerHTML, /result.png/);

  f.wb.openLink('https://chosen.example.test');
  f.wb.render(f.current.root, snapshot, [{ ...image, artifactId: 'image-b', at: 2 }]);
  assert.match(f.current.body.innerHTML, /chosen.example.test/);
  f.click('data-wb-close');
  f.wb.render(f.current.root, snapshot, [{ ...image, artifactId: 'image-c', at: 3 }]);
  assert.equal(f.wb.state().open, false, 'a later result must respect manually hidden previews');
});

test('unreferenced historical, supporting and verification images never automatically open the workbench', () => {
  for (const extra of [{ changedInTurn: false }, { primary: false }, { processEvidence: true }, { deleted: true }]) {
    const f = fixture();
    f.wb.render(f.current.root, { messages: [{ role: 'user', blocks: [{ kind: 'text', text: 'Check' }] },
      { role: 'assistant', blocks: [{ kind: 'text', text: 'Check completed.' }] }] },
    [{ artifactId: 'image', name: 'result.png', relative: 'result.png', primary: true, changedInTurn: true, ...extra }]);
    assert.equal(f.wb.state().open, false, JSON.stringify(extra));
  }
});

test('explicit new screenshot evidence can replace an automatic website preview without taking manual focus', () => {
  const f=fixture();
  const web={artifactId:'web',name:'index.html',relative:'index.html',path:'C:/site/index.html',kind:'website',primary:true,changedInTurn:true,at:1};
  const shot={artifactId:'shot',name:'screen.png',relative:'screen.png',kind:'image',primary:false,processEvidence:true,changedInTurn:true,at:2};
  const snapshot={messages:[{role:'user',text:'Build a website'},{role:'assistant',blocks:[{kind:'text',text:'[网站](index.html)'}]}]};
  // No cwd is supplied by this fixture: a relative trusted web entry is sufficient.
  delete web.path;
  f.wb.render(f.current.root,snapshot,[web,shot]);
  assert.match(f.current.body.innerHTML,/ncw-browser/);
  snapshot.messages[1].blocks[0].text+='\n![网页截图](screen.png)';
  f.wb.render(f.current.root,snapshot,[web,shot]);
  assert.match(f.current.body.innerHTML,/ncw-image/,'the explicitly shown screenshot becomes the automatic preview');
  assert.match(f.current.tabs.innerHTML,/index.html/);assert.match(f.current.tabs.innerHTML,/screen.png/);
  f.wb.openLink('https://chosen.example.test');
  const next={...shot,artifactId:'next',name:'next.png',relative:'next.png',at:3};
  snapshot.messages[1].blocks[0].text+='\n[新截图](next.png)';
  f.wb.render(f.current.root,snapshot,[web,shot,next]);
  assert.match(f.current.body.innerHTML,/chosen.example.test/);
  assert.match(f.current.tabs.innerHTML,/next.png/,'a manual selection keeps focus while the new screenshot remains selectable');
  f.click('data-wb-close');
  f.wb.render(f.current.root,snapshot,[web,shot,{...next,at:4}]);
  assert.equal(f.wb.state().open,false);
});

test('a referenced historical screenshot stays manually accessible without automatic activation', () => {
  const f=fixture();
  const shot={artifactId:'old-shot',name:'screen.png',relative:'screen.png',kind:'image',primary:false,processEvidence:true,changedInTurn:false,at:1};
  f.wb.render(f.current.root,{messages:[{role:'user',text:'Refer to old evidence'},
    {role:'assistant',blocks:[{kind:'text',text:'[旧截图](screen.png)'}]}]},[shot]);
  assert.equal(f.wb.state().open,false);
  assert.equal(f.wb.openOutput('old-shot'),true);
  assert.match(f.current.body.innerHTML,/ncw-image/);
});

test('an explicit current screenshot can replace an automatic live service and does not enter the next turn', () => {
  const f = fixture();
  const shot = { artifactId:'service-shot', name:'screen.png', relative:'screen.png',
    primary:false, processEvidence:true, changedInTurn:true, at:2 };
  const snapshot = { messages:[{role:'user',blocks:[{kind:'text',text:'Build the site'}]}], tools:[
    { id:'server', name:'bash', state:'running', after:0,
      args:{command:'npm run dev'}, partial:'Local: http://localhost:5173/' },
  ] };
  f.wb.render(f.current.root,snapshot,[shot]);
  assert.match(f.current.body.innerHTML,/127\.0\.0\.1:5173/);
  snapshot.messages.push({role:'assistant',blocks:[{kind:'text',text:'![网页截图](screen.png)'}]});
  f.wb.render(f.current.root,snapshot,[shot]);
  assert.match(f.current.body.innerHTML,/ncw-image/);
  f.switch();
  snapshot.messages.push({role:'user',blocks:[{kind:'text',text:'Unrelated next request'}]});
  f.wb.render(f.current.root,snapshot,[shot]);
  assert.equal(f.wb.state().open,false,'old references cannot select a screenshot for the next turn');
});
