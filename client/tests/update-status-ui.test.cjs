'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function source(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

test('设置页持续呈现安全更新和阻塞工作，而不是一次性提示', () => {
  const html = source('desk.html');
  const settings = source('components/settings/settings.js');
  assert.match(html, /id="clientUpdateBadge"/);
  assert.match(html, /id="clientUpdateBlockers"/);
  assert.match(settings, /onClientUpdateStatus/);
  assert.match(settings, /已停止接收新的本机工作/);
  assert.match(settings, /installClientUpdate/);
  assert.match(settings, /当前版本/);
  assert.match(settings, /尚未安装/);
  assert.doesNotMatch(settings, /installerPath/);
});

test('管理端区分等待执行结束并展示服务端保存的阻塞摘要', () => {
  const screen = source('../hub-frontend/src/screens/Clients.jsx');
  assert.match(screen, /updateMaintenance/);
  assert.match(screen, /waiting:\s*tx\(['"]等待当前执行结束['"]\)/);
  assert.match(screen, /已停止向这台设备派发新需求/);
  assert.match(screen, /setInterval\(refresh,\s*3000\)/);
});
