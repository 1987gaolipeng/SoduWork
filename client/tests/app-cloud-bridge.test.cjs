'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const personal = require('../main/personal-plugins');
const grant = require('../main/pi-session/plugin-grant');
const contract = require('../main/soduwork-app-bridge-contract.cjs');
test('own app MCP stays local, grants one turn, redacts and cleans credentials; invalid scope fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-cloud-grant-'));
  const app = { isPackaged: false, getPath: () => root };
  try {
    const plugin = personal.create(app, { key: 'cloud-test', name: 'Cloud fixture', version: '0.1.0', template: 'connector',
      description: 'A cloud test connector', instructions: 'Only use the current test space.', mcpServers: ['media-ops-cloud'] }).plugin;
    const item = { appBridge: { appId: 'plugin:' + plugin.pluginId, origin: 'http://127.0.0.1:19001' } };
    require('../main/work-preview-app-owner.cjs').capture(item, { app });
    const connect = params => require('../main/work-preview-app-connection.cjs').connect({ item }, params, { app });
    const params = { server: 'media-ops-cloud', url: item.appBridge.origin + '/mcp', token: 'fixture-opaque-credential' };
    for (const url of ['http://other.invalid/mcp', params.url + '?x=1', item.appBridge.origin + '/other', 'http://user:pass@127.0.0.1:19001/mcp']) {
      assert.throws(() => connect({ ...params, url }), /来源/);
    }
    assert.throws(() => connect({ ...params, server: 'undeclared' }), /未声明/);
    const reply = connect(params); assert.equal(reply.connected, true); assert.ok(!JSON.stringify(reply).includes(params.token));
    const options = { app, cwd: root, ref: 'cloud-fixture', pluginIds: [plugin.pluginId], appContext: { pluginId: plugin.pluginId, connection: item.appConnection },
      identityOf: async () => { throw Error('Own app must not request remote Hub credentials'); },
      fetchImpl: async () => { throw Error('Own app must not fetch remote Hub'); } };
    const resolved = await grant.resolve(options), file = resolved.grant.configFile;
    const spec = JSON.parse(fs.readFileSync(file)).servers['media-ops-cloud'];
    assert.equal(spec.appLease, true);
    assert.match(spec.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.notEqual(spec.headers.Authorization, 'Bearer ' + params.token);
    assert.equal(resolved.grant.redact(spec.headers.Authorization.slice(7)), '[已隐藏凭据]');
    assert.equal(resolved.grant.redact(params.token), '[已隐藏凭据]'); assert.ok(!resolved.grant.guide.includes(params.token));
    resolved.grant.cleanup(); assert.equal(fs.existsSync(file), false);
    await assert.rejects(grant.resolve({ ...options, appContext: { ...options.appContext, connection: { ...item.appConnection, expiresAt: 1 } } }), /已失效/);
    await assert.rejects(grant.resolve({ ...options, appContext: { ...options.appContext, connection: null } }), /先从即用/);
    await assert.rejects(grant.resolve({ ...options, appContext: { ...options.appContext, connection: { ...item.appConnection, pluginId: 'local:another' } } }), /已失效/);
    assert.equal(connect({ ...params, token: '' }).connected, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('composer requests require send permission and stable operation IDs', () => {
  assert.equal(contract.METHOD_CAPABILITY['composer.send'], 'conversation.send');
  assert.throws(() => contract.normalizeRequest({ id: 'test', method: 'composer.send', params: { text: 'hello' } }));
  assert.equal(contract.normalizeRequest({ id: 'test', method: 'composer.send', params: { text: 'hello', requestId: 'series-1' } }).params.text, 'hello');
});
test('native admission routes to the owned composer, rejects forged receipts, deduplicates retries', async () => {
  const chat = require('../main/work-preview-app-chat.cjs'), wc = new EventEmitter();
  let payload, count = 0;
  wc.isDestroyed = () => false; wc.send = (_channel, value) => { payload = value; count++; };
  const item = { composer: { view: { webContents: wc } }, appBridge: { appId: 'plugin:local:admission', origin: 'https://fixture.invalid' } };
  require('../main/work-preview-app-owner.cjs').capture(item, { app: { getPath: () => os.tmpdir() } });
  const request = { text: 'Set up this series', requestId: 'series-once' };
  const result = chat.send(item, request);
  assert.equal(chat.finish({}, { id: payload.id, ok: true }).ok, false);
  assert.equal(chat.send(item, request), result);
  assert.equal((await chat.send(item, { ...request, text: 'different' })).ok, false);
  chat.finish(wc, { id: payload.id, ok: true }); assert.equal((await result).accepted, true);
  assert.equal((await chat.send(item, request)).ok, true); assert.equal(count, 1);
  const failed = chat.send(item, { ...request, requestId: 'retry' });
  chat.finish(wc, { id: payload.id, ok: false }); assert.equal((await failed).ok, false);
  const retry = chat.send(item, { ...request, requestId: 'retry' });
  chat.finish(wc, { id: payload.id, ok: true }); assert.equal((await retry).ok, true); assert.equal(count, 3);
});
test('shell refresh follows runtime settlement even when UI still reports a busy draft', () => {
  let listener, tick, refreshes = 0;
  const api = { workPreview: { composerHello() {}, onComposerSession() {}, onComposerPut() {}, onComposerSubmit() {}, onComposerMode() {},
    composerTurnSettled() { refreshes++; } }, conversationSession: { onEvent(callback) { listener = callback; return () => {}; } } };
  const window = { __deskPanel: 'chatbar', soduWorkAPI: api, NativeChat: { sessionInfo: () => ({ ref: 'own-session' }), isBusy: () => true }, addEventListener() {} };
  const sandbox = { window, NativeChat: window.NativeChat, document: { readyState: 'loading', addEventListener() {} },
    setInterval(callback) { tick = callback; return 1; }, clearInterval() {}, setTimeout() {} };
  require('node:vm').runInNewContext(fs.readFileSync(path.resolve(__dirname, '../components/panels/chatbar-embed.js'), 'utf8'), sandbox);
  tick();
  listener({ ref: 'different-app', snapshot: { status: 'streaming', execution: { running: true } } });
  listener({ ref: 'own-session', snapshot: { status: 'streaming', execution: { running: true } } });
  listener({ ref: 'own-session', snapshot: { status: 'idle', execution: { running: false } } });
  tick(); tick();
  assert.equal(refreshes, 1);
});
test('native composer surfaces have stable private identities and detach on WebContents destruction', () => {
  const preview = require('../main/work-preview'), original = preview.isAppComposer;
  const one = new EventEmitter(), two = new EventEmitter(), main = new EventEmitter();
  let destroyed = false;
  for (const [index, wc] of [one, two, main].entries()) { wc.id = index + 101; wc.isDestroyed = () => wc === one && destroyed; }
  preview.isAppComposer = wc => wc === one || wc === two;
  const ordinary = { webContents: main }, BrowserWindow = { fromWebContents: () => ordinary };
  try {
    const surfaces = require('../main/conversation/app-surfaces.cjs');
    const first = surfaces.forSender(BrowserWindow, one), second = surfaces.forSender(BrowserWindow, two);
    assert.equal(surfaces.forSender(BrowserWindow, one), first);
    assert.notEqual(first, second); assert.equal(first.webContents, one);
    assert.equal(surfaces.forSender(BrowserWindow, main), ordinary);
    assert.deepEqual(surfaces.all([ordinary]), [ordinary, first, second]);
    let closed = false; first.once('closed', () => { closed = true; });
    destroyed = true; one.emit('destroyed'); assert.equal(closed, true);
    assert.deepEqual(surfaces.all([ordinary]), [ordinary, second]);
    two.emit('destroyed'); assert.deepEqual(surfaces.all([ordinary]), [ordinary]);
  } finally { preview.isAppComposer = original; }
});


test('directory and mention protocol accepts only public bounded fields and explicit capabilities',()=>{
 assert.equal(contract.METHOD_CAPABILITY['directory.list'],'directory.read');
 assert.equal(contract.METHOD_CAPABILITY['composer.mention'],'notifications.send');
 assert.throws(()=>contract.normalizeRequest({id:'x',method:'directory.list',params:{account:'foreign'}}));
 const valid={recipientUserId:'user-1',text:'核对内容',requestId:'mention-1'};
 assert.equal(contract.normalizeRequest({id:'x',method:'composer.mention',params:valid}).params.recipientUserId,'user-1');
 for(const params of [{...valid,text:'x'.repeat(501)},{...valid,recipientUserId:[]},{...valid,requestId:''},{...valid,sendNow:true}])assert.throws(()=>contract.normalizeRequest({id:'x',method:'composer.mention',params}));
});

test('native mention opens only its own composer, has an honest review receipt, deduplicates and fails a stale scope',async()=>{
 const chat=require('../main/work-preview-app-chat.cjs'),wc=new EventEmitter();let payload,calls=0,current=true;
 wc.isDestroyed=()=>false;wc.send=(channel,value)=>{assert.equal(channel,'app-composer-submit');payload=value;calls++;};
 const item={composer:{view:{webContents:wc}}},params={recipientUserId:'user-1',text:'请核对',requestId:'mention-once'},options={mention:true,assertCurrent:()=>{if(!current)throw Error('账号已变化');}};
 item.appBridge = { appId: 'plugin:local:mention', origin: 'https://fixture.invalid' };
 require('../main/work-preview-app-owner.cjs').capture(item, { app: { getPath: () => os.tmpdir() } });
 const promise=chat.send(item,params,item,options);assert.equal(payload.kind,'mention');assert.equal(payload.mention.recipientUserId,'user-1');
 assert.equal(chat.send(item,params,item,options),promise);assert.equal(chat.finish({}, {id:payload.id,ok:true}).ok,false);
 chat.finish(wc,{id:payload.id,ok:true,state:'review'});const result=await promise;assert.equal(result.state,'review');assert.equal(result.opened,true);assert.equal(result.accepted,undefined);assert.equal(calls,1);
 const stale=chat.send(item,{...params,requestId:'stale'},item,options);current=false;chat.finish(wc,{id:payload.id,ok:true,state:'review'});assert.equal((await stale).ok,false);
});

test('SDK directory and mention use declared request methods and do not run a model turn',async()=>{
 const calls=[],window={crypto:require('node:crypto').webcrypto,addEventListener(){},soduWorkAppBridge:{request:async(method,params)=>{calls.push({method,params});return {ok:true,state:'review'};},events:{onTurnSettled(){}}}};window.parent=window;
 const vm=require('node:vm');vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../sdk/soduwork-app.js'),'utf8'),{window,location:{origin:'https://fixture.invalid'},document:{referrer:'',querySelectorAll:()=>[]},URL,Set,Map,Promise});
 await window.soduWorkApp.directory.list();await window.soduWorkApp.chat.mention({recipientUserId:'user-1',text:'内容',requestId:'sdk-mention'});
 assert.deepEqual(calls.map(row=>row.method),['directory.list','composer.mention']);assert.equal(calls[1].params.recipientUserId,'user-1');assert.equal(calls[1].params.requestId,'sdk-mention');
});
