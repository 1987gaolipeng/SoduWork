'use strict';
// Isolated Electron, production catalog UI, in-memory API. No user profile/network.
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'soduwork-skill-selection-evidence'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-selection-'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', profile);
const report = { ok: false, checks: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const js = source => win.webContents.executeJavaScript(source, true);
async function until(source) {
  for (let i = 0; i < 200; i++) { if (await js(source)) return; await delay(25); }
  throw Error('Timed out: ' + source);
}
async function click(selector) {
  const point = await js(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  await delay(30);
}
async function stable() {
  assert.deepEqual(await js(`(() => ({
    nodes: Object.entries(held).every(([id, node]) => document.getElementById(id) === node),
    button: document.querySelector('[data-skill="fixture-30"]') === heldButton,
    focus: document.activeElement === heldFocus,
    scroll: document.querySelector('#capContent').scrollTop === heldScroll,
    otherCards: [...document.querySelectorAll('[data-skill]')].every((node, i) => node === heldCards[i]),
  }))()`), { nodes: true, button: true, focus: true, scroll: true, otherCards: true });
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1200, height: 680,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const requests = [];
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (info, done) => {
    requests.push(info.url); done({ cancel: true });
  });
  await win.loadFile(path.join(__dirname, 'fixtures/capability-toolbar.html'));
  await until('!!document.querySelector("[data-cap-tab=skills]")');
  await js(`(async () => {
    catalog.skills = Array.from({ length: 45 }, (_, i) => ({ name: 'fixture-' + i,
      description: 'Isolated Skill ' + i, enabled: true, status: 'enabled', available: true, portable: true,
      scope: 'company', builtIn: true }));
    window.savedCalls = []; window.failNext = false; window.holdSave = false;
    SoduWorkAPI.setMySkills = async names => {
      savedCalls.push(names.slice());
      if (holdSave) await new Promise(resolve => window.finishSave = () => { holdSave = false; resolve(); });
      if (failNext) { failNext = false; throw Error('isolated save failure'); }
      catalog.skills.forEach(item => { item.enabled = names.includes(item.name); item.status = item.enabled ? 'enabled' : 'available'; });
      return { enabled: names.slice() };
    };
    await openCapabilityPanel();
  })()`);
  await click('[data-cap-tab="skills"]');
  await until('document.querySelectorAll("[data-skill]").length === 45 && !document.querySelector("#capSkillRefresh").disabled');
  await js(`window.holdSave = true; window.heldButton = document.querySelector('[data-skill="fixture-30"]');
    window.heldCards = [...document.querySelectorAll('[data-skill]')];
    window.held = Object.fromEntries(['capBody', 'capContent', 'capSearch', 'capActions', 'capAddButton'].map(id => [id, document.getElementById(id)]));
    window.otherMutations = []; window.observer = new MutationObserver(records => otherMutations.push(...records));
    heldCards.filter(node => node !== heldButton).forEach(node => observer.observe(node.closest('.cap-skill-card'), { subtree: true, childList: true, attributes: true }));`);
  await click('[data-skill="fixture-30"]');
  await until('typeof finishSave === "function"');
  await js(`window.heldFocus = document.activeElement; window.heldScroll = document.querySelector('#capContent').scrollTop;`);
  assert.ok(await js('heldScroll > 0'), 'exercise real scrolling');
  await js('finishSave()');
  await until('document.querySelector("#capSkillSaveState").textContent === "已自动保存"');
  await stable();
  assert.equal(await js('heldButton.getAttribute("aria-pressed")'), 'false');
  assert.equal(await js('otherMutations.length'), 0, 'unrelated Skill cards must not be mutated');
  report.checks.push('Single toggle preserves all card/control nodes, focused switch, and nonzero scroll after saving');

  await js(`window.heldFocus = document.querySelector('#capSearch'); heldFocus.focus({ preventScroll: true });
    window.holdRefresh = true; document.querySelector('#capSkillRefresh').click();`);
  await until('typeof finishRefresh === "function"');
  await js('finishRefresh()');
  await until('!document.querySelector("#capSkillRefresh").disabled');
  await stable();
  report.checks.push('Unchanged catalog refresh preserves search focus, nodes, and scroll');

  await js(`window.failNext = true; heldButton.click();`);
  await until('document.querySelector("#capSkillSaveState").textContent === "自动保存失败"');
  await stable();
  assert.equal(await js('heldButton.getAttribute("aria-pressed")'), 'true');
  report.checks.push('Failed save retains the unsaved selection and focused control without rebuilding the page');

  await js(`document.querySelector('#capSkillRefresh').click();`);
  await until('document.querySelector("#capSkillSaveState").textContent === "已自动保存" && !document.querySelector("#capSkillRefresh").disabled');
  await stable();
  report.checks.push('Refresh retries the failed selection and preserves the view');

  await js(`window.holdRefresh = true; document.querySelector('#capSkillRefresh').click();`);
  await until('document.querySelector("#capSkillRefresh").disabled');
  await js(`window.holdSave = true; heldButton.click();`);
  await until('document.querySelector("#capSkillSaveState").textContent === "正在自动保存…"');
  await js('finishRefresh()');
  await until('!document.querySelector("#capSkillRefresh").disabled');
  assert.equal(await js('heldButton.getAttribute("aria-pressed")'), 'false');
  await until('savedCalls.length === 4');
  await js('finishSave()');
  await until('document.querySelector("#capSkillSaveState").textContent === "已自动保存"');
  await stable();
  report.checks.push('Catalog response requested before a newer toggle cannot revert its UI or persistence');

  fs.writeFileSync(path.join(output, 'skill-selection.png'), (await win.webContents.capturePage()).toPNG());
  assert.deepEqual(await js('errors'), []); assert.deepEqual(requests, []);
  await js('closeCapabilityPanel()'); report.ok = true;
}).catch(error => { report.error = error.stack; }).finally(() => {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(report.ok ? 0 : 1);
});
