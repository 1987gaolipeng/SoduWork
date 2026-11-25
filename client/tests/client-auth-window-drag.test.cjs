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

test('authentication reserves native window dragging for a fixed caption above the scrolling surface', () => {
  assert.match(css, /html\.soduwork-auth-pending body > :not\(#soduWorkClientAuthGate\)/);
  assert.doesNotMatch(css, /\.soduwork-auth-gate\s*\{[^}]*-webkit-app-region:\s*drag/);
  assert.match(css, /\.soduwork-auth-gate::before\s*\{[^}]*position:\s*fixed;[^}]*-webkit-app-region:\s*drag/);
});

test('password field has a reveal toggle that flips the input type and resets after clearing', () => {
  assert.match(js, /soduwork-auth-pw-eye/, '缺少眼睛按钮');
  assert.match(js, /type="button"/, '切换按钮必须是 type=button，避免触发表单提交');
  assert.match(
    js,
    /passwordInput\.type = show \? 'text' : 'password'/,
    '缺少 type 明文/掩码切换',
  );
  const submit = js.slice(js.indexOf('async function submit(event)'), js.indexOf('function confirmLogout()'));
  assert.match(js, /function resetPasswordView\(\) \{\s*if \(passwordInput\) passwordInput\.type = 'password';/,
    '清空后必须恢复 password 掩码');
  assert.match(submit, /\}\);\s*if \(legacySubmission !== attempt\) return;\s*passwordInput\.value = '';\s*resetPasswordView\(\);/,
    '只清空并复位当前登录请求的密码');
  assert.match(submit, /catch \(error\) \{\s*if \(legacySubmission !== attempt\) return;\s*passwordInput\.value = '';\s*resetPasswordView\(\);/,
    '当前登录请求异常时也要清空密码并恢复掩码');
});
