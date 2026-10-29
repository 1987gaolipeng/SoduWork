'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');

test('account center keeps profile editing behind the account summary entry', () => {
  const source = read('components/client-auth/account-center.js');
  const auth = read('components/client-auth/client-auth.js');
  assert.match(source, /function openProfileEditor\s*\(/);
  assert.match(source, /data-account-profile-editor/);
  assert.match(source, /openProfileEditor/);
  assert.match(auth, /data-account-profile-editor/);
  assert.doesNotMatch(auth, /soduwork-account-menu-btn|soduwork-account-menu-wrap|data-action="(?:change-password|logout)"/);
});

test('logout confirmation is an AccountUI modal with cancel and confirm outcomes', () => {
  const source = read('components/client-auth/client-auth.js');
  assert.match(source, /AccountUI\.modal/);
  assert.match(source, /clientLogout\(\)/);
  assert.match(source, /resolve\(false\)/);
  assert.match(source, /resolve\(true\)/);
  assert.doesNotMatch(source, /global\.confirm\(/);
});

test('account center management navigation renders security, devices and privacy tabs', () => {
  const source = read('components/client-auth/account-center.js');
  assert.match(source, /const tabs = \['security', 'devices', 'privacy'\]/);
  assert.match(source, /tabs\.map\(.*data-tab/);
  assert.doesNotMatch(source, /data-tab=\\\"profile\\\"/);
});

test('workspace and account avatars use circular clipping surfaces', () => {
  const authCss = read('components/client-auth/client-auth.css');
  const workspaceCss = read('components/workspace/workspace-navigation.css');
  const accountCss = read('components/client-auth/personal-account.css');
  assert.match(authCss, /\.soduwork-account-avatar\s*\{[\s\S]*?border-radius:\s*50%/);
  assert.match(workspaceCss, /\.ws-avatar\{[\s\S]*?border-radius:50%/);
  assert.match(accountCss, /#personalAccountPanel \.soduwork-account-avatar\s*\{[\s\S]*?border-radius:\s*50%/);
});
