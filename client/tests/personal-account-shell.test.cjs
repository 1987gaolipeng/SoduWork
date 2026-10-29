'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('personal account owns account controls while preferences retains one entry', () => {
  const html = read('desk.html');
  const account = html.slice(html.indexOf('<section class="panel personal-account-panel"'), html.indexOf('<div class="panel" id="settingsPanel">'));
  const settings = html.slice(html.indexOf('<div class="panel" id="settingsPanel">'), html.indexOf('<div class="panel" id="shortcutsPanel">'));
  for (const id of ['personalAccountPanel', 'personalAccountSummary', 'personalAccountContent', 'boxNameInput', 'boxNameSave', 'boxBindNote']) {
    assert.equal(html.split('id="' + id + '"').length - 1, 1, id + ' is unique');
    assert.ok(account.includes('id="' + id + '"'), id + ' belongs to personal account');
  }
  assert.match(account, /personal-account-device[^>]*hidden/);
  assert.doesNotMatch(settings, /id="personalInfoOpen"|personal-info-entry|管理个人账户/);
  assert.doesNotMatch(settings, /id="boxName(?:Input|Save)"/);
  assert.equal(html.split('href="components/client-auth/personal-account.css"').length - 1, 1);
  const css = read('components/client-auth/personal-account.css');
  assert.match(css, /#personalAccountPanel:not\(\.show\),[\s\S]*?\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /max-width:\s*920px/);
  assert.match(css, /var\(--ws-main-left/);
  assert.match(css, /prefers-reduced-motion/);
});

test('settings navigation distinguishes the personal information link from the account page title', () => {
  const source = read('components/workspace/workspace-shell.js');
  const groups = vm.runInNewContext(source.match(/const SETTINGS_GROUPS = (\[[\s\S]*?\n  \]);/)[1]);
  assert.equal(groups.some(group => group[0] === '个人账户'), false);
  const aiGroup = groups.find(group => group[0] === 'AI 与账号');
  assert.equal(JSON.stringify(aiGroup[1].slice(0, 2)), JSON.stringify(['account', 'usage']));
  const keys = groups.flatMap(group => group[1]);
  assert.equal(keys.filter(key => key === 'account').length, 1);
  assert.equal(keys.filter(key => key === 'usage').length, 1);
  assert.ok(keys.indexOf('account') < keys.indexOf('usage'));
  const metadata = source.match(/const META = (\{[\s\S]*?\n  \});/)[1];
  const nav = source.slice(source.indexOf('  const wsT ='), source.indexOf('  const groupLabel ='));
  const value = vm.runInNewContext('const META=' + metadata + ';' + nav + '; ({title:META.account[0],label:navLabel("account"),html:navLabelHtml("account")})', { global: {} });
  assert.equal(value.title, '个人信息');
  assert.equal(value.label, '个人信息');
  assert.match(value.html, /个人信息/);
});

test('workspace routes account tabs and releases account listeners before another page opens', () => {
  const events = [];
  const panels = new Map(['personalAccountPanel', 'settingsPanel'].map(id => {
    const classes = new Set();
    return [id, { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } }];
  }));
  const scope = { console, setTimeout, clearTimeout, __deskPanel: 'workspace', __deskArgs: {},
    addEventListener() {}, document: {
      readyState: 'loading', addEventListener() {}, documentElement: { setAttribute() {} },
      getElementById: id => panels.get(id) || null, querySelector: () => null,
      querySelectorAll: () => Array.from(panels.values()),
    }, AccountCenter: {
      openInPanel: tab => { events.push('account:' + tab); panels.get('personalAccountPanel').classList.add('show'); },
      closePanel: () => { events.push('account:close'); panels.get('personalAccountPanel').classList.remove('show'); },
    }, openSettings: () => events.push('settings:open'), closeSettings: () => events.push('settings:close'),
  };
  scope.window = scope;
  vm.runInNewContext(read('desk-boot.js'), scope);
  scope.WorkspaceHost.open('account');
  assert.equal(scope.WorkspaceHost.view, 'account');
  assert.equal(panels.get('personalAccountPanel').classList.contains('workspace-hosted'), true);
  scope.WorkspaceHost.open('account', { tab: 'security' });
  scope.WorkspaceHost.open('settings');
  assert.deepEqual(events, ['account:security', 'account:security', 'account:close', 'settings:open']);
  assert.equal(panels.get('personalAccountPanel').classList.contains('show'), false);
  assert.equal(panels.get('personalAccountPanel').classList.contains('workspace-hosted'), false);
  scope.WorkspaceHost.open('account', { tab: 'devices' });
  assert.deepEqual(events.slice(-2), ['settings:close', 'account:devices']);
});

test('both bottom avatar entry points open the personal account security page', () => {
  const source = read('components/workspace/workspace-shell.js');
  assert.match(source, /function openPersonalAccount\(\)[\s\S]*?WorkspaceHost\.open\('account', \{ tab: 'security' \}\)/);
  assert.match(source, /#wsMine[\s\S]*?openPersonalAccount\(\)/);
  assert.match(source, /#wsRailMine[\s\S]*?openPersonalAccount\(\)/);
  assert.match(source, /id="wsMine"[^>]*title="打开个人信息"/);
  assert.match(source, /id="wsRailMine"[^>]*title="打开个人信息"/);
  const css = read('components/workspace/workspace-navigation.css');
  assert.match(css, /\.ws-avatar\s*>\s*\.ac-account-avatar-image[\s\S]*?border-radius:50%/);
  assert.match(css, /\.ws-rail-avatar\s*>\s*\.ac-account-avatar-image[\s\S]*?border-radius:50%/);
});

test('account center exposes only management tabs and normalizes profile deep links to security', () => {
  const source = read('components/client-auth/account-center.js');
  assert.match(source, /const tabs = \['security', 'devices', 'privacy'\]/);
  assert.match(source, /const normalizeTab = value => value === 'profile' \? 'security'/);
  assert.doesNotMatch(source, /tabs = \['profile', 'security', 'devices', 'privacy'\]/);
});

test('account summary provides a keyboard profile editor trigger', () => {
  const source = read('components/client-auth/account-center.js');
  const auth = read('components/client-auth/client-auth.js');
  assert.match(source, /openProfileEditor/);
  assert.match(auth, /data-account-profile-editor/);
  assert.match(auth, /event\.key !== 'Enter'/);
  assert.match(auth, /event\.key !== ' '/);
});

test('account deep links survive main-process validation and initial desk parsing', () => {
  const state = require('../main/workspace-state.cjs').create({ ownerOf: () => 'alice' });
  const payload = state.resolve({ panel: 'workspace', view: 'account', tab: 'privacy' });
  assert.equal(payload.view, 'account');
  const scope = { URLSearchParams, location: { search: '?' + new URLSearchParams(payload) }, window: {},
    document: { documentElement: { setAttribute() {} }, addEventListener() {} } };
  vm.runInNewContext(read('desk.html').match(/<script>([\s\S]*?)<\/script>/)[1], scope);
  assert.equal(scope.window.__deskArgs.view, 'account');
  assert.equal(scope.window.__deskArgs.tab, 'privacy');
});
