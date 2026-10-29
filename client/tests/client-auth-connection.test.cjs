'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '..', 'components', 'client-auth', 'client-auth.js'),
  'utf8',
);
const emailSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'components', 'client-auth', 'email-auth.js'),
  'utf8',
);

function runtime(config) {
  const document = {
    readyState: 'loading',
    documentElement: { classList: { add() {} } },
    addEventListener() {},
  };
  const window = {
    SoduWorkAPI: { hubConfig: () => config },
  };
  vm.runInNewContext(source, {
    window,
    document,
    setTimeout,
    clearTimeout,
    Intl,
  });
  return window.ClientAuth;
}

test('connection failures explain network recovery without offering an environment switch', () => {
  for (const environment of ['development', 'production']) {
    const auth = runtime({ environment, hub: 'http://127.0.0.1:9080' });
    const message = auth.connectionMessage({ error: 'TypeError: fetch failed' });
    assert.match(message, /SoduWork/);
    assert.match(message, /\u68c0\u67e5\u7f51\u7edc/);
    assert.doesNotMatch(message, /fetch failed|127\.0\.0\.1|\u672c\u673a\u670d\u52a1|\u66f4\u6539\u670d\u52a1/);
  }
});

test('credential errors remain server-provided instead of being mislabeled as connectivity failures', () => {
  const auth = runtime({
    environment: 'production',
    hub: 'http://192.0.2.10:8989',
    productionHub: 'http://192.0.2.10:8989',
  });
  assert.equal(auth.connectionMessage({ error: '账号或密码错误' }), '账号或密码错误');
});

test('fixed-service recovery keeps retry; the address panel renders only when editable', () => {
  assert.match(source, /soduwork-auth-retry/);
  /* Retain the panel definition but render editable connection controls only when the main process permits them. */
  assert.match(source, /soduwork-auth-connection/);
  assert.match(source, /editable !== true|editable === true/);
  assert.doesNotMatch(source, /soduwork-auth-local|soduwork-auth-production/);
  assert.doesNotMatch(source, /function switchToLocal|function switchToProduction/);
});

test('both login surfaces keep the footer service address as plain connection text', () => {
  for (const surface of [source, emailSource]) {
    assert.match(surface, /<span class="soduwork-auth-hub">(?:连接|\\u8fde\\u63a5) <b><\/b><\/span>/);
    assert.doesNotMatch(surface, /soduwork-auth-service-entry|bindServiceEntry|当前客户端使用固定的 SoduWork 服务/);
  }
});

/* Preserve the remote runtime badge without turning it into a connection selector. */
test('login page distinguishes local-code runs from packaged installs', () => {
  assert.match(source, /soduwork-auth-form-badge/);
  assert.match(source, /本地代码启动/);
  assert.match(source, /runtimeForm\(\) === 'local-code'/);
  assert.match(source, /formBadge\.hidden = !isLocalCode/);
  assert.match(source, /function switchConnection/);
  assert.doesNotMatch(source, /DEFAULT_DEVELOPMENT_HUB/);
});
