'use strict';

/* Protect the password-change flow from menu through dialog, API, and server session invalidation. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const authSource = fs.readFileSync(
  path.join(root, 'components', 'client-auth', 'client-auth.js'), 'utf8');
const apiSource = fs.readFileSync(
  path.join(root, 'api.js'), 'utf8');
const backendSource = fs.readFileSync(
  path.resolve(root, '..', 'hub-backend', 'app', 'api', 'client_auth.py'), 'utf8');

function runtime(config) {
  const document = {
    readyState: 'loading',
    documentElement: { classList: { add() {} } },
    addEventListener() {},
  };
  const window = {
    SoduWorkAPI: { hubConfig: () => config },
  };
  vm.runInNewContext(authSource, {
    window, document, setTimeout, clearTimeout, Intl,
  });
  return window.ClientAuth;
}

test('account card keeps profile editing while security owns password and logout actions', () => {
  const auth = runtime({
    environment: 'development',
    hub: 'http://127.0.0.1:9080',
    productionHub: 'http://192.0.2.10:8989',
  });
  const html = auth.accountCardHtml();
  assert.match(html, /soduwork-account-person[^>]*data-account-profile-editor/, 'profile editor trigger is missing');
  assert.doesNotMatch(html, /soduwork-account-menu(?:-wrap|-btn|-item|-sep)?/, 'duplicate account menu must be removed');
  assert.doesNotMatch(html, /data-action="(?:change-password|logout|account-center)"/,
    'duplicate account actions must be removed from the summary card');
  assert.doesNotMatch(html, /soduwork-account-logout/,
    'legacy bare logout button must not come back');
  const centerSource = fs.readFileSync(
    path.join(root, 'components', 'client-auth', 'account-center.js'), 'utf8');
  assert.match(centerSource, /data-password-change/, 'security tab password action is missing');
  assert.match(centerSource, /data-logout/, 'security tab logout action is missing');
});

test('change-password modal machinery exists and signs out after success', () => {
  assert.match(authSource, /function ensureChangePwdModal/);
  assert.match(authSource, /async function submitChangePwd/);
  assert.match(authSource, /async function signOutAfterPasswordChange/);
  assert.match(authSource, /soduworkPwdCurrent/, 'current password input is missing');
  assert.match(authSource, /soduworkPwdNew/, 'new password input is missing');
  assert.match(authSource, /soduworkPwdConfirm/, 'confirm password input is missing');
  assert.match(authSource, /clientChangePassword/, 'api call is missing');
  assert.match(authSource, /setTimeout\(function \(\) \{ return signOutAfterPasswordChange\(scope\); \}, 1400\)/,
    'auto sign-out must retain the initiating account scope and its success delay');
});

test('mask blank-click close requires mousedown to start on the mask', () => {
  /*
   * Use pointerdown origin when dismissing the backdrop so selecting password text and
   * releasing outside cannot close the dialog.
   */
  assert.match(authSource, /addEventListener\('mousedown'[^]*?pwdDownOnMask = /m,
    'mousedown origin tracking is missing');
  const clickGuard = authSource.match(/pwdMask\.addEventListener\('click', function \(event\) \{([^}]*)\}\);/);
  assert.ok(clickGuard, 'mask click guard is missing');
  assert.match(clickGuard[1], /event\.target === pwdMask/,
    'mask click must still check the target');
  assert.match(clickGuard[1], /pwdDownOnMask/,
    'mask click must also require the press to have started on the mask');
});

test('Escape closes the modal without closing the settings window', () => {
  // Escape leaves the native window open while the password dialog handles its own dismissal.
  const bootSource = fs.readFileSync(path.join(__dirname, '..', 'desk-boot.js'), 'utf8');
  const escape = bootSource.slice(bootSource.indexOf("if (e.key !== 'Escape') return;"));
  assert.doesNotMatch(escape, /closeWindow\(\)/, 'desk-boot must never hide the window on Escape');
  const panelsSource = fs.readFileSync(path.join(__dirname, '..', 'components', 'panels', 'panels.js'), 'utf8');
  assert.match(panelsSource, /soduWorkPwdModal/, 'panels Escape must yield to the modal');
});

test('api layer exposes clientChangePassword against the documented route', () => {
  assert.match(apiSource, /clientChangePassword/);
  assert.match(apiSource, /\/client-auth\/change-password/);
});

test('backend enforces validation and revokes every active session', () => {
  assert.match(backendSource, /change-password/);
  assert.match(backendSource, /PASSWORD_MISMATCH/, 'wrong-current-password guard is missing');
  assert.match(backendSource, /validate_password/, 'length guard via validate_password is missing');
  assert.match(backendSource, /PASSWORD_UNCHANGED/, 'unchanged guard is missing');
  assert.match(backendSource, /auth_version/, 'auth_version bump is missing');
  assert.match(backendSource, /client\.password\.change/, 'audit action is missing');
});
