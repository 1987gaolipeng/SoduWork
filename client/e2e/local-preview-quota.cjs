'use strict';
// Opt-in validation against the isolated local preview Hub. No model is called.
const { app, BrowserWindow, webContents } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const client = path.resolve(__dirname, '..');
const state = process.env.SODUWORK_LOCAL_PREVIEW_STATE;
if (!state || !process.env.SODUWORK_USER_DATA || !path.resolve(process.env.SODUWORK_USER_DATA).startsWith(path.resolve(state) + path.sep)) {
  throw Error('An explicit isolated preview profile is required');
}
const config = JSON.parse(fs.readFileSync(path.join(state, 'local-settings.json'), 'utf8'));
const hub = 'http://127.0.0.1:18989';
const report = { ok: false, cases: [], errors: [] };
app.setAppPath(client);
app.on('web-contents-created', (_event, content) => {
  content.on('console-message', (_event, level, message) => {
    if (level >= 3) report.errors.push(String(message).slice(0, 300));
  });
});
require('../main.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await delay(100); }
  throw Error('Preview state did not become ready');
}
app.whenReady().then(async () => {
  const auth = require('../main/device-auth');
  await until(() => auth.identity(app, hub));
  const identity = auth.identity(app, hub);
  const logged = await auth.login(app, { hub, clientId: identity.clientId, account: 'admin', password: config.admin_password,
    name: 'Local PostgreSQL preview', workRoot: path.join(state, 'work') });
  assert.equal(logged.ok, true, logged.error);
  const used = Number(logged.quota?.used || 0), limit = used + 1000;
  const content = await until(() => webContents.getAllWebContents().find(w => w.getURL().includes('/desk.html')));
  content.reload();
  const run = code => content.executeJavaScript(code, true);
  await until(async () => { try { return await run('!!window.ClientAuth?.snapshot().user'); } catch (_) { return false; } });
  await run('SoduWorkI18n.setLocale("zh-CN")');
  const win = BrowserWindow.fromWebContents(content); win?.show();
  const adminResponse = await fetch(hub + '/api/v1/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'admin', pw: config.admin_password }) });
  const admin = await adminResponse.json(); assert.ok(admin.token);
  const setQuota = async limit => {
    const response = await fetch(hub + '/api/v1/admin/users/' + admin.user.id, { method: 'PATCH',
      headers: { Authorization: 'Bearer ' + admin.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenQuota: { mode: 'limited', limit } }) });
    assert.equal(response.status, 200);
  };
  const authorize = require('../main/conversation/quota-admission.cjs').create({ app,
    identityOf: () => auth.authenticatedIdentity(app, hub, identity.clientId),
    onQuotaExceeded: detail => content.send('device-auth-quota-exceeded', detail) });
  const expected = await auth.authenticatedIdentity(app, hub, identity.clientId);
  try {
    await setQuota(0);
    await assert.rejects(authorize(expected), /额度/);
    await until(() => run('!!document.querySelector(".soduwork-quota-notice:not([hidden])")'));
    const notice = await run('document.querySelector(".soduwork-quota-notice").innerText');
    assert.match(notice, /暂停/); assert.ok(notice.includes(used.toLocaleString('zh-CN') + ' / 0'));
    assert.equal(await run('document.body.classList.contains("soduwork-client-auth-open")'), false);
    report.cases.push('zero quota blocks admission, shows actual usage and pause, preserves authenticated workspace');
    await delay(500);
    fs.writeFileSync(path.join(state, 'quota-notice.png'), (await content.capturePage()).toPNG());
    await setQuota(limit);
    const restored = await authorize(expected); assert.equal(restored.exceeded, false);
    report.cases.push('raising the limit restores admission without signing in again');
    const usage = await fetch(hub + '/api/v1/usage/events', { method: 'POST',
      headers: { Authorization: 'Device ' + expected.session, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: 'local-preview-quota-test-' + require('node:crypto').randomUUID(), usage: { input: 1000 } }) });
    assert.equal(usage.status, 200);
    await run('(() => { const input = document.querySelector("#cpInput"); input.value="Quota validation draft"; input.dispatchEvent(new Event("input", {bubbles:true})); })()');
    await assert.rejects(authorize(expected), /额度/);
    await until(() => run('document.querySelector(".soduwork-quota-notice").innerText.includes(' +
      JSON.stringify(limit.toLocaleString('zh-CN') + ' / ' + limit.toLocaleString('zh-CN')) + ')'));
    assert.equal(await run('document.querySelector("#cpInput").value'), 'Quota validation draft');
    await delay(500);
    fs.writeFileSync(path.join(state, 'quota-exhausted.png'), (await content.capturePage()).toPNG());
    report.cases.push('reported usage reaches the limit, blocks admission and preserves the message draft');
    await setQuota(1000000);
    assert.equal((await authorize(expected)).exceeded, false);
    for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
      await run(`SoduWorkI18n.setLocale(${JSON.stringify(locale)}); WorkspaceHost.open('shortcuts');`);
      const title = await run('document.querySelector("[data-shortcut-row=focus-composer] .shortcut-row-title").textContent');
      if (locale !== 'zh-CN') assert.doesNotMatch(title, /聚焦对话输入框/);
      assert.equal(await run('ShortcutSettings.getBinding("focus-composer")'), 'Ctrl+L');
      report.cases.push(locale + ' shortcut labels preserve command bindings');
    }
    await delay(500);
    fs.writeFileSync(path.join(state, 'shortcuts-ko.png'), (await content.capturePage()).toPNG());
    await run('SoduWorkI18n.setLocale("zh-CN"); WorkspaceHost.open("create"); document.querySelector(".soduwork-quota-notice button")?.click(); const input = document.querySelector("#cpInput"); input.value=""; input.dispatchEvent(new Event("input", {bubbles:true}));');
    await delay(500);
    report.ok = true;
  } finally {
    await setQuota(1000000);
  }
}).catch(error => { report.failure = String(error.stack); }).finally(() => {
  fs.writeFileSync(path.join(state, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  app.exit(report.ok ? 0 : 1);
});
