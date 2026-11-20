'use strict';

const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
if (typeof electron === 'string') {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-thinking-preset-'));
  const env = { ...process.env, SODUWORK_THINKING_PRESET_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => {
    clearTimeout(timer); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); process.exitCode = code ?? 1;
  });
} else {
  const { app, BrowserWindow } = electron, assert = require('node:assert/strict');
  const output = process.argv[2], profile = process.env.SODUWORK_THINKING_PRESET_PROFILE;
  assert.ok(output && path.isAbsolute(output) && profile, 'Use the Node launcher and an absolute evidence directory');
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', profile); app.disableHardwareAcceleration();
  const report = { ok: false, cases: [], screenshots: [], boundary: 'Real Electron renderer with a synthetic settings API; no production account, model service or user configuration.' };
  const expected = { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' };
  let win;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code);
  async function until(code) { for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait(40); } throw Error('Timeout: ' + code); }
  async function select(value) {
    await js(`(() => { const field = document.querySelector('[data-mdfield="thinkingPreset"]'); field.value = ${JSON.stringify(value)};
      field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  }
  async function shot(name) {
    await wait(100); const file = path.join(output, name + '.png');
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); report.screenshots.push(file);
  }
  async function run() {
    win = new BrowserWindow({ show: false, width: 1280, height: 1000,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, 'fixtures/model-settings.html'));
    await until('document.querySelectorAll(".md-nav-item").length === 6');
    await js(`(async () => { fixture.myModels[0] = { providerId: 'personal', name: 'gateway-model', label: 'Synthetic model',
      config: { thinkingMode: 'auto', imageRouting: 'auto', maxOutputTokens: 16384 }, ctxWindow: 128000 };
      await _mdLoad(); selectService('personal'); document.querySelector('[data-mdedit]').click(); })()`);
    assert.equal(await js('document.querySelector("[data-mdfield=thinkingPreset]").value'), 'custom');
    await select('glm-5.3');
    assert.equal(await js('document.querySelector("[data-paddthinking]").value'), 'always');
    assert.equal(await js('document.querySelector("[data-paddthinking]").disabled'), true);
    assert.equal(await js('document.querySelector("[data-mdfield=thinkingFormat]").value'), 'zai');
    assert.equal(await js('document.querySelector("[data-mdfield=supportsReasoningEffort]").value'), 'yes');
    await js('document.querySelector("[data-mdcancel]").click()');
    assert.equal(await js('_mdMyModels[0].config.thinkingMode'), 'auto');
    assert.equal(await js('fixture.myModels[0].config.thinkingMode'), 'auto');
    report.cases.push('Selecting and cancelling a preset never changes the existing model');
    await js('document.querySelector("[data-mdedit]").click()'); await select('glm-5.3');
    await js('selectService("company"); selectService("personal")');
    assert.equal(await js('document.querySelector("[data-paddthinking]").disabled'), true);
    await select('custom');
    assert.equal(await js('document.querySelector("[data-paddthinking]").value'), 'auto');
    assert.equal(await js('document.querySelector("[data-paddthinking]").disabled'), false);
    await select('glm-5.3');
    await js('document.querySelector("[data-madd]").click(); saveFailure = true');
    assert.deepEqual(await js('_mdMyModels[0].config.thinkingLevelMap'), expected);
    assert.equal(await js('_mdSave(false)'), false);
    assert.equal(await js('fixture.myModels[0].config.thinkingMode'), 'auto');
    assert.deepEqual(await js('_mdMyModels[0].config.thinkingLevelMap'), expected);
    report.cases.push('Custom settings survive redraws and a failed save preserves the stored model and editable retry');
    await js('saveFailure = false'); assert.equal(await js('_mdSave(false)'), true);
    const saved = await js('fixture.myModels[0]');
    assert.deepEqual(saved.config.thinkingLevelMap, expected);
    assert.equal(saved.name, 'gateway-model'); assert.equal(saved.label, 'Synthetic model');
    assert.equal(saved.config.maxOutputTokens, 16384); assert.equal(saved.ctxWindow, 128000);
    await js('selectService("personal"); document.querySelector("[data-mdedit]").click(); document.querySelector(".md-cap-advanced").open = true');
    assert.equal(await js('document.querySelector("[data-mdfield=thinkingPreset]").value'), 'glm-5.3');
    assert.equal(await js('document.querySelector("[data-paddthinking]").disabled'), true);
    await js('document.querySelector("[data-mdfield=thinkingPreset]").scrollIntoView({ block: "center" })'); await shot('preset-zh');
    report.cases.push('Saving and reopening retain legal low/high/max levels, aliases and token budgets');
    await js('SoduWorkI18n.setLocale("en-US")'); await wait(150);
    assert.equal(await js('document.querySelector("[data-mdfield=thinkingPreset] option:checked").textContent'), 'GLM 5.3 (always reasons)');
    assert.match(await js('document.querySelector("[data-md-thinking-preset-note]").textContent'), /low effort/);
    await shot('preset-en');
    win.setSize(820, 720); await wait(150);
    await js('document.querySelector("[data-mdfield=thinkingPreset]").scrollIntoView({ block: "center" })');
    assert.ok(await js('document.getElementById("mdBody").scrollWidth <= document.getElementById("mdBody").clientWidth + 1'));
    await shot('preset-narrow');
    report.cases.push('English translation and narrow layout preserve preset values');
    assert.deepEqual(await js('errors'), []); report.ok = true;
  }
  app.whenReady().then(run).catch(async error => {
    report.error = error.stack;
    if (win) report.diagnostics = await js('({ errors, notice: window.notice, editor: document.querySelector(".md-model-editor")?.innerText })').catch(() => null);
  }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
