'use strict';
// Real Pi runtime, local script, Electron preload, conversation renderer and report IPC.
// Only Skill discovery and the model HTTP replies are isolated fixtures.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, clipboard, ClipboardItem } = electron;
  const path = require('node:path'), os = require('node:os'), fs = require('node:fs');
  const assert = require('node:assert/strict');
  const context = require('../main/pi-session/skill-failure-context.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-report-'));
  const output = process.env.SODUWORK_SKILL_FAILURE_EVIDENCE || path.join(__dirname, '../../outputs/skill-failure-context');
  app.setPath('userData', root);
  app.disableHardwareAcceleration();
  let fixture, win, expected, previous, usedClipboard = false, verdict = 1;
  const clipboardText = async () => (await clipboard.readText()).replace(/\r\n/g, '\n');
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    fixture = await require('./fixtures/resumed-pi.cjs').create(path.join(root, 'runtime'));
    const skillDir = path.join(root, 'csv-validator');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: csv-validator\ndescription: Validate the sample CSV\n---\nRun the check in validate-sample.cjs.');
    fs.writeFileSync(path.join(fixture.cwd, 'validate-sample.cjs'),
      "require('node:fs').writeFileSync('executed.txt', 'validated'); console.error('Missing column: amount. password=fixture-private'); process.exitCode = 3;");
    const prompt = 'Validate the sample CSV.';
    const iat = Math.floor(Date.now() / 1000), claims = { uid: 'fixture-account', typ: 'device', cid: 'fixture', iat, exp: iat + 600 };
    const identity = { hub: 'https://example.invalid', clientId: claims.cid,
      session: Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + '0'.repeat(64) };
    const item = { name: 'csv-validator', version: '1.2.3', path: skillDir, installed: true };
    const resolveSkills = require('../main/pi-session/skill-turn').resolver({ app, identity, identityOf: async () => identity,
      skillDirs: () => [skillDir], fetchPolicy: async () => ({ ok: true, skills: [item] }),
      ensure: async () => ({ ok: true, contracts: [item] }), onResolved: (id, items) => context.prepared(handle, id, items) });
    const handle = await fixture.open({ resolveSkills });
    context.bind(app, handle, identity);
    fixture.reply((body, index) => index === 1 ? { tool: 'bash', args: { command: 'node validate-sample.cjs' } }
      : { text: 'The sample is missing a required column.' });
    const submitted = await handle.submit(prompt, [], { skills: [item.name], submissionId: 'csv-report-turn' });
    assert.ok(submitted.accepted);
    await submitted.completion;
    const snapshot = handle.snapshot();
    assert.ok(fs.existsSync(path.join(fixture.cwd, 'executed.txt')), 'local script must have run: ' + JSON.stringify(snapshot.tools));
    const failure = context.summary(handle, snapshot);
    assert.ok(failure, 'failed tool must belong to this skill turn: ' + JSON.stringify({ tools: snapshot.tools, messages: snapshot.messages }));
    const session = { get: ref => ref === 'detail-fixture' && handle };
    ipcMain.handle('pi-session-skill-failure-context', context.handler({ BrowserWindow, session }));
    const preload = path.join(__dirname, '../preload.js');
    win = new BrowserWindow({ show: false, width: 1050, height: 850, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
    handle.attachedWindow = win;
    await win.loadFile(path.join(__dirname, 'fixtures/tool-details-lazy.html'));
    win.webContents.setZoomFactor(0.82);
    const js = code => win.webContents.executeJavaScript(code, true);
    await js('showSnapshot(' + JSON.stringify({ ...snapshot, skillFailure: failure }) + ')');
    await js("document.querySelector('[data-skill-failure]').click()");
    async function until(check) {
      for (let i = 0; i < 160; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw Error('Report did not reach expected state: ' + await js('document.body.innerText.slice(-800)'));
    }
    const report = await until(() => js("document.querySelector('dialog pre')?.textContent"));
    for (const value of ['csv-validator (1.2.3)', prompt, 'node validate-sample.cjs', 'Missing column: amount', require('node:child_process').execFileSync('node', ['--version'], { encoding: 'utf8' }).trim().slice(1), 'Python', 'workspace'])
      assert.ok(report.includes(value), value);
    assert.match(report, /code 3/);
    assert.doesNotMatch(report, /fixture-private/);
    assert.match(report, /(?:Windows_NT|Linux|Darwin)/);
    const calls = fixture.requests.length;
    // On an interactive test desktop, restore existing clipboard formats atomically.
    expected = report;
    if (process.env.SODUWORK_E2E_CLIPBOARD === '1') {
      previous = [];
      for (const item of await clipboard.read()) {
        const formats = {};
        for (const type of item.types) formats[type] = await item.getType(type);
        previous.push(new ClipboardItem(formats));
      }
      usedClipboard = true; win.show(); win.focus(); win.webContents.focus();
    } else {
      await js("Object.defineProperty(navigator, 'clipboard', {value:{writeText:async text=>{window.copiedReport=text}}})");
    }
    await js("document.querySelector('[data-copy-skill-failure]').click()");
    const copied = await until(async () => usedClipboard ? await clipboardText() === report && report : js('window.copiedReport'));
    assert.equal(copied, report);
    assert.equal(fixture.requests.length, calls);
    await new Promise(resolve => setTimeout(resolve, 250));
    fs.writeFileSync(path.join(output, 'skill-failure-report.png'), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(await js('window.errors'), []);
    const result = { passed: true, actualLocalScript: true, scriptExitCode: 3, model: 'loopback fixture',
      noAdditionalModelRequests: true, maskedValueAbsent: true, copyTextMatchesReport: true, systemClipboard: usedClipboard };
    fs.writeFileSync(path.join(output, 'skill-failure-results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result)); verdict = 0;
  }).catch(error => { console.error(error.stack || error); }).finally(async () => {
    if (usedClipboard && await clipboardText() === expected) {
      if (previous.length) await clipboard.write(previous); else clipboard.clear();
    }
    if (win && !win.isDestroyed()) win.destroy();
    await fixture?.close();
    app.exit(verdict);
  });
}
