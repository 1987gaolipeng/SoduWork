'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('模型页使用服务列表与配置详情的主从布局', () => {
  const panel = read('components', 'panels', 'panels-models.js');
  assert.match(panel, /cfg-master-detail md-master-detail/);
  assert.match(panel, /data-mdselect=/);
  for (const label of ['连接设置', '访问凭据', '模型清单']) assert.ok(panel.includes(label));
  assert.match(panel, /密钥保存后只显示配置状态，不回显明文/);
  assert.match(panel, /id="mdQ"/);
  assert.match(panel, /id="mdAddInline"/);
  assert.doesNotMatch(panel, /openDeskWindow\(\{ panel: 'model-editor'/);
});

test('代码账号页使用凭据导航与安全详情的主从布局', () => {
  const panel = read('components', 'panels', 'panels-codeacct.js');
  assert.match(panel, /cfg-master-detail ca-master-detail/);
  for (const key of ['identity', 'token', 'ssh', 'test']) {
    assert.match(panel, new RegExp("_caNavItem\\('" + key + "'"));
  }
  assert.match(panel, /凭据只写不读/);
  assert.match(panel, /按任务归属人署名/);
  assert.match(panel, /不会修改远端内容/);
});

test('两个 Electron 入口加载同一套响应式连接中心样式', () => {
  const css = read('components', 'panels', 'panels-connections.css');
  const desk = read('desk.html');
  const overlay = read('index.html');
  assert.match(desk, /panels-connections\.css/);
  assert.match(overlay, /panels-connections\.css/);
  assert.match(css, /grid-template-columns:320px minmax\(0,1fr\)/);
  assert.match(css, /@media\(max-width:720px\)/);
  assert.match(css, /\.cfg-nav-item\.is-selected::before/);
});

test('模型连接控件继承主题并按可用内容宽度响应', () => {
  const css = read('components', 'panels', 'panels-connections.css');
  assert.doesNotMatch(css, /#(?:dc3547|e23546|202735|f5f6f8|d75a68)\b/i);
  assert.match(css, /container:model-page \/ inline-size/);
  assert.match(css, /@container model-page \(max-width:660px\)/);
  assert.match(css, /#mdPanel \.md-mtag button svg/);
  assert.match(css, /#mdPanel \.md-test\.primary\{[^}]*var\(--accent\)/);
  assert.doesNotMatch(css, /font-size:(?:9|10|11)(?:\.\d+)?px/);
});
