'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/codex-auth-dialog.js'), 'utf8');
function fixture() {
  const window = { addEventListener() {} }; vm.runInNewContext(source, { window }); return window.CodexAuthDialog;
}

function interactiveFixture(change = {}) {
  const nodes = [], events = new Map(), calls = [];
  const state = { key: 'codex', installed: true, auth: 'unauthed', authStatus: 'unknown',
    state: 'unauthed', loginAvailable: true, loginFlowVersion: 1, isolatedLoginAvailable: true, ...change };
  const document = { activeElement: { isConnected: true, focus() {} }, body: { append() {} },
    createElement(tag) {
      const element = { tag, className: '', dataset: {}, listeners: {}, children: [], hidden: false,
        disabled: false, append(...children) { this.children.push(...children); },
        setAttribute() {}, addEventListener(name, callback) { this.listeners[name] = callback; },
        focus() {}, showModal() { this.open = true; }, close() { this.open = false; },
        remove() { this.removed = true; } };
      nodes.push(element); return element;
    } };
  const api = {
    agentSetup: async runnerId => ({ machines: [{ runnerId, agents: [state] }] }),
    agentInstall: async (key, action, runnerId, options) => { calls.push({ key, action, runnerId, options }); return { jobId: 'auth-job' }; },
    agentJob: async () => ({ state: 'done', auth: { state: 'failed', reason: 'status_unavailable' } }),
  };
  const window = { SoduWorkAPI: api, addEventListener: (name, callback) => events.set(name, callback) };
  vm.runInNewContext(source, { window, document, setTimeout: () => 1, clearTimeout() {} });
  const result = window.CodexAuthDialog.open({ runnerId: 'selected-runner' });
  const element = name => nodes.find(node => node.className === 'codex-auth-' + name);
  return { api, calls, events, state, result, element,
    click: name => element(name).listeners.click(),
    settle: () => new Promise(resolve => setImmediate(resolve)) };
}

test('unknown installed status waits for explicit continuation and preserves a failed native recheck', async () => {
  const f = interactiveFixture();
  await f.settle();
  assert.equal(f.element('dialog').dataset.state, 'ready');
  assert.equal(f.element('primary').textContent, '继续检查');
  assert.match(f.element('description').textContent, /暂时无法确认登录状态/);
  assert.deepEqual(f.calls, []);
  await f.click('primary');
  assert.deepEqual(f.calls, [{ key: 'codex', action: 'login', runnerId: 'selected-runner', options: undefined }]);
  assert.equal(f.element('dialog').dataset.state, 'failed');
  assert.equal(f.element('device').hidden, true);
  assert.match(f.element('description').textContent, /无法确认登录状态/);
  await f.click('close');
  assert.equal(await f.result, false);
});

test('unknown status can explicitly recheck and reuse an existing native login without a device code', async () => {
  const f = interactiveFixture();
  f.api.agentJob = async () => ({ state: 'done', auth: { state: 'succeeded', reused: true } });
  await f.settle();
  await f.click('primary');
  assert.equal(f.element('dialog').dataset.state, 'succeeded');
  assert.equal(f.element('device').hidden, true);
  assert.equal(f.calls.length, 1);
  await f.click('close');
  assert.equal(await f.result, true);
});

test('unknown status retains a separate explicit authorization choice', async () => {
  const f = interactiveFixture();
  await f.settle();
  const recovery = f.element('foot').children[1];
  assert.equal(recovery.hidden, false);
  recovery.listeners.click();
  assert.equal(f.element('primary').textContent, '开始独立授权');
  assert.deepEqual(f.calls, []);
  await f.click('primary');
  assert.equal(f.calls[0].action, 'login-isolated');
  await f.click('close');
});

test('unknown status without login capability remains unavailable and cancellation starts no work', async () => {
  for (const change of [{ installed: false }, { loginAvailable: false }, { loginFlowVersion: 0 }, {}]) {
    const f = interactiveFixture(change);
    await f.settle();
    assert.equal(f.element('dialog').dataset.state, Object.keys(change).length ? 'failed' : 'ready');
    await f.click('close');
    assert.deepEqual(f.calls, []);
    assert.equal(await f.result, false);
  }
});

test('an account switch invalidates a pending unknown-status recheck receipt', async () => {
  const f = interactiveFixture();
  let release, polls = 0;
  f.api.agentInstall = () => new Promise(resolve => { release = resolve; });
  f.api.agentJob = async () => { polls++; return {}; };
  await f.settle();
  const pending = f.click('primary');
  assert.equal(f.element('dialog').dataset.state, 'starting');
  assert.equal(f.element('status').children[1].textContent, '正在检查登录状态');
  f.events.get('soduwork-data-scope-changed')();
  release({ jobId: 'old-account-job' });
  await pending;
  assert.equal(await f.result, false);
  assert.equal(f.element('dialog').removed, true);
  assert.equal(polls, 0);
});
test('device metadata accepts only official exact URLs, bounded codes and recognized states', () => {
  const api = fixture(), valid = {state:'waiting',verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGH',expiresAt:1000};
  assert.equal(api.metadata(valid).userCode,'ABCD-EFGH');
  for (const verificationUrl of ['javascript:alert(1)','https://evil.invalid/','https://auth.openai.com/codex/device?token=secret','https://auth.openai.com/codex/device#secret']) assert.equal(api.metadata({...valid,verificationUrl}),null);
  for (const userCode of ['<script>','Bearer secret','A'.repeat(99),'ABCD EFGH']) assert.equal(api.metadata({...valid,userCode}),null);
  for (const expiresAt of [undefined,NaN,Infinity,0,-1]) assert.equal(api.metadata({...valid,expiresAt}),null);
  assert.equal(api.metadata({state:'future',access_token:'secret'}),null);
  assert.deepEqual(JSON.parse(JSON.stringify(api.metadata({state:'succeeded',access_token:'secret'}))),{state:'succeeded'});
  assert.deepEqual(JSON.parse(JSON.stringify(api.metadata({state:'failed',reason:'access_denied',detail:'secret'}))),
    {state:'failed',reason:'access_denied'});
  assert.deepEqual(JSON.parse(JSON.stringify(api.metadata({state:'failed',reason:'secret-token',detail:'secret'}))),
    {state:'failed'});
});
test('cancellation transport retains the original qualified job and cannot leak it into install actions', async () => {
  const api = fs.readFileSync(path.join(__dirname,'../api.js'),'utf8');
  const start = api.indexOf('    async agentInstall('), end = api.indexOf('    async agentProbe(',start);
  const calls = [], context = {jfetch:async(url,options)=>{calls.push(JSON.parse(options.body));return{jobId:'job'}},taskStorageKey:()=> 'fixture-account',mark(){}};
  const method = vm.runInNewContext('({' + api.slice(start,end) + '})',context).agentInstall;
  await method('codex','login-cancel','runner-a',{jobId:'runner|runner-a|job-a'});
  await method('codex','login','runner-a',{jobId:'unrelated'});
  await method('pi','install','runner-b');
  assert.deepEqual(calls,[{key:'codex',action:'login-cancel',runnerId:'runner-a',jobId:'runner|runner-a|job-a'},
    {key:'codex',action:'login',runnerId:'runner-a'},{key:'pi',action:'install',runnerId:'runner-b'}]);
});

test('authorization inventory reads only the selected machine while ordinary inventory remains compatible', async () => {
  const api = fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8');
  const start = api.indexOf('    async agentSetup('), end = api.indexOf('    async agentInstall(', start);
  const calls = [], context = {jfetch: async url => {calls.push(url); return {machines:[{runnerId:'selected'}]};}, taskStorageKey:()=> 'fixture-account', mark(){}};
  const method = vm.runInNewContext('({' + api.slice(start, end) + '})', context).agentSetup;
  await method('machine & one'); await method(''); await method();
  assert.deepEqual(calls, ['/agent-setup?runnerId=machine%20%26%20one', '/agent-setup?runnerId=', '/agent-setup']);
});

test('every authorization message translates through the production locale manifest', () => {
  const context=vm.createContext({Intl,Map,Set,Object,localStorage:{getItem:()=>null,setItem(){}},
    document:{readyState:'loading',documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener(){}},
    CustomEvent:class{},addEventListener(){},dispatchEvent(){},setTimeout,clearTimeout});
  vm.runInContext('window=globalThis',context);
  const root=path.join(__dirname,'../core');
  for(const file of JSON.parse(fs.readFileSync(path.join(root,'locales/manifest.json'),'utf8')))
    vm.runInContext(fs.readFileSync(path.join(root,'locales',file),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(root,'i18n.js'),'utf8'),context);
  const messages=[...new Set([...source.matchAll(/'([^'\n]*[\u3400-\u9fff][^'\n]*)'/g)].map(match=>match[1]))];
  assert.ok(messages.length>30);
  for(const locale of ['en-US','ja-JP','ko-KR']) {
    context.SoduWorkI18n.setLocale(locale);
    for(const message of messages) assert.notEqual(context.SoduWorkI18n.translateText(message),message,`${locale}: ${message}`);
  }
});
