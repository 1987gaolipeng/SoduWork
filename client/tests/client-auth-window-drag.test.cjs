'use strict';

/*
 * Verify login-window dragging while normal title controls are hidden and password
 * visibility toggling with masking restored after clearing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const componentDir = path.resolve(__dirname, '..', 'components', 'client-auth');
const css = fs.readFileSync(path.join(componentDir, 'client-auth.css'), 'utf8');
const js = fs.readFileSync(path.join(componentDir, 'client-auth.js'), 'utf8');

test('login gate drags as a whole while interactive controls stay no-drag', () => {
  /*
   * The authentication gate must provide its own drag region because login hides the
   * ordinary window-menu region.
   */
  assert.match(css, /html\.soduwork-auth-pending body > :not\(#soduWorkClientAuthGate\)/);
  assert.match(
    css,
    /\.soduwork-auth-gate\s*\{[^}]*-webkit-app-region:\s*drag/,
    '登录遮罩缺少整层 -webkit-app-region: drag',
  );
  assert.match(
    css,
    /\.soduwork-auth-gate input,\s*\.soduwork-auth-gate button,\s*\.soduwork-auth-gate summary\s*\{[^}]*-webkit-app-region:\s*no-drag/,
    '输入框/按钮/summary 必须豁免 no-drag，否则无法交互',
  );
});

test('password field has a reveal toggle that flips the input type and resets after clearing', () => {
  assert.match(js, /soduwork-auth-pw-eye/, '缺少眼睛按钮');
  assert.match(js, /type="button"/, '切换按钮必须是 type=button，避免触发表单提交');
  assert.match(
    js,
    /passwordInput\.type = show \? 'text' : 'password'/,
    '缺少 type 明文/掩码切换',
  );
  assert.match(js, /resetPasswordView/, '缺少清空后收回掩码的复位逻辑');
  assert.match(js, /passwordInput\.value = '';\s*resetPasswordView\(\);/, '登录返回后清空密码并复位掩码');
  assert.match(js, /catch \(error\) \{\s*passwordInput\.value = '';\s*resetPasswordView\(\);/,
    '登录异常后也应清空密码并复位掩码');
});
