'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const icons = require('../core/plugin-icon');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/chat-message-plugins.js'), 'utf8');
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture(catalog) {
  const ctx = { esc, _ref: 'chat-a' }; let owner = 'account-a', refreshes = 0, calls = 0;
  const sandbox = { SoduWorkPluginIcon: icons, ChatPluginMentionModel: require('../components/panels/chat-plugin-mention-model'), SoduWorkAPI: {
    taskStorageKey: () => owner, pluginCatalog: () => { calls++; return catalog(); },
  } };
  sandbox.localStorage = { getItem: () => null };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/panels-apps.js'), 'utf8'), sandbox);
  vm.runInNewContext(source, sandbox);
  const view = sandbox.ChatMessagePlugins.create(ctx, () => refreshes++);
  return { ctx, view, sandbox, switchOwner: value => { owner = value; }, refreshes: () => refreshes, calls: () => calls };
}
const badge = {pluginId:'builder',name:'插件开发助手',version:'1.0',scopeLabel:'个人'};
const tick = () => new Promise(resolve => setImmediate(resolve));
test('消息插件使用与加号菜单一致的目录图标，保留历史名称与版本', async () => {
  const item = {...badge,name:'目录新名称',capabilities:{skills:['builder']}};
  const f = fixture(async () => ({items:[item]}));
  f.view.html([badge]); await tick();
  const html = f.view.html([badge]);
  assert.ok(html.includes(icons.markup(item)));
  assert.match(html, /wc-plugin-icon/); assert.match(html, /插件开发助手/); assert.match(html, /v1.0/);
  assert.doesNotMatch(html, /目录新名称|<button/); assert.equal(f.calls(), 1);
});
test('使用加号菜单的对话专用能力归一化，避免误显示成普通插件', async () => {
  const item = {...badge,capabilities:{},conversationCapabilities:{skills:['builder']}};
  const f = fixture(async()=>({items:[item]})); f.view.html([badge]); await tick();
  const normalized = require('../components/panels/chat-plugin-mention-model').normalizeCatalog({items:[item]})[0];
  assert.ok(f.view.html([badge]).includes(icons.markup(normalized)));
});
test('不同历史消息共用一次目录读取，不因插件列表不同循环刷新', async () => {
  const f = fixture(async () => ({items:[{...badge,kind:'skill'}]}));
  for (let i=0;i<5;i++) { f.view.html([badge]); f.view.html([{pluginId:'other',name:'另一插件'}]); }
  await tick();
  assert.equal(f.calls(), 1); assert.equal(f.refreshes(), 1);
});
test('关闭或切换账号后的迟到目录不能刷新新会话', async () => {
  let finish; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.view.html([badge]); await tick(); f.view.reset(); f.switchOwner('account-b');
  finish({items:[{...badge,kind:'skill'}]}); await tick();
  assert.equal(f.refreshes(), 0);
});
test('切换会话时拒绝旧目录结果，并为新会话重新读取', async () => {
  let finish; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.view.html([badge]); await tick(); f.ctx._ref = 'chat-b';
  finish({items:[{...badge,kind:'skill'}]}); await tick(); assert.equal(f.refreshes(), 0);
  f.view.html([badge]); await tick(); assert.equal(f.calls(), 2);
});
test('目录不可用或历史插件已移除时，名称仍显示且不在每次渲染重复请求', async () => {
  const f = fixture(async () => { throw Error('offline'); });
  f.view.html([badge]); await tick();
  for (let i=0;i<4;i++) assert.match(f.view.html([badge]), /插件开发助手/);
  assert.equal(f.calls(), 1); assert.equal(f.refreshes(), 0);
});
test('恶意名称和不安全图标不能作为 HTML 或外部图片加载', async () => {
  const f = fixture(async () => ({items:[{...badge,icon:'https://example.invalid/x.png'}]}));
  f.view.html([badge]); await tick();
  const html = f.view.html([{...badge,name:'<img src=x onerror=alert(1)>'}]);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|https:\/\//);
});
test('应用卡片在正常使用后可打开即用，普通插件仍只显示原徽标', async () => {
  const app = { ...badge, pluginId: 'local:app', name: '已配置应用', description: '应用一行简介', personal: true,
    ui: { contributions: [{ slot: 'workspace.navigation' }] } };
  const f = fixture(async () => ({ items: [app, badge] }));
  assert.equal(f.view.cards([{ pluginId: app.pluginId }]), '');
  await tick();
  const html = f.view.cards([{ pluginId: app.pluginId }, badge]);
  assert.match(html, /data-chat-open-app="local:app"/);
  assert.match(html, /已配置应用/); assert.match(html, /打开即用/);
  assert.match(html, /appsx-card-txt/); assert.match(html, /应用一行简介/);
  assert.match(html, /appsx-set/); assert.match(html, /appsx-fav/);
  assert.match(html, /data-chat-app="local:app" role="button" tabindex="0"/);
  assert.doesNotMatch(html, /appsx-cover-card/);
  assert.equal((html.match(/nmessage-app-card/g) || []).length, 1);
  assert.equal(f.calls(), 1);
  f.switchOwner('account-b');
  assert.equal(f.view.cards([{ pluginId: app.pluginId }]), '', 'cards cannot reuse another account catalog');
});

test('应用右侧按宿主 ID 隐藏自身卡片，其他应用和主窗口历史仍可展示', async () => {
  const apps = ['local:a', 'market:b'].map(pluginId => ({ pluginId, name: '同名应用',
    ui: { contributions: [{ slot: 'workspace.navigation' }] } }));
  const f = fixture(async () => ({ items: apps }));
  f.sandbox.__deskPanel = 'chatbar';
  let hostId = apps[0].pluginId;
  f.sandbox.SoduWorkAppConversations = { applicationId: () => hostId };
  f.view.cards(apps); await tick();
  assert.equal(f.view.cards([apps[0]]), '');
  assert.doesNotMatch(f.view.cards(apps), /data-chat-app="local:a"/);
  assert.match(f.view.cards(apps), /data-chat-app="market:b"/);
  assert.match(f.view.html([apps[0]]), /同名应用/, 'message badge remains');
  hostId = apps[1].pluginId;
  assert.match(f.view.cards(apps), /data-chat-app="local:a"/);
  assert.doesNotMatch(f.view.cards(apps), /data-chat-app="market:b"/);
  f.sandbox.__deskPanel = 'chat';
  assert.match(f.view.cards(apps), /data-chat-app="market:b"/, 'main window shows the same transcript card');
  assert.match(f.view.cards(apps), /data-chat-app="local:a"/);
});
