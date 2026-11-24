'use strict';
// Exercise generated skill delivery through the production install dialog,
// authenticated Hub catalog and both runtime resource preparation paths.
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const fixture = require('./fixtures/created-skill-history.cjs');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-e2e-')));
  function run(args, timeout) {
    const result = require('node:child_process').spawnSync(electron, args, { env, windowsHide: true, stdio: 'inherit', timeout });
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  try {
    const seeded = run([require.resolve('./fixtures/created-skill-history.cjs'), root], 60000);
    process.exitCode = seeded || run([__filename, process.argv[2] || '', root], 180000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow, ipcMain } = electron;
  const net = require('node:net');
  const { spawn, execFileSync } = require('node:child_process');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const client = path.resolve(__dirname, '..'), repo = path.dirname(client);
  const root = process.argv[3] || fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-e2e-')));
  const out = path.resolve(process.argv[2] || path.join(repo, 'outputs/created-skill-install'));
  const { name, skillChat, otherChat } = fixture;
  const source = path.join(root, name);
  let references = fixture.references;
  const report = { ok: false, cases: [], errors: [] };
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
  let win, backend, identity, base, worker, history, current;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => win.webContents.executeJavaScript(code, true);
  async function until(check, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { if (await check()) return; } catch {} await pause(40); }
    throw Error('Timed out: ' + label);
  }
  async function request(route, account = identity) {
    const response = await fetch(base + '/api/v1' + route, {
      headers: { Authorization: 'Device ' + account.session } });
    assert.equal(response.ok, true, 'Fixture request failed: ' + route);
    return response.json();
  }
  async function mutations() {
    const response = await fetch(base + '/fixture/mutations');
    assert.equal(response.ok, true);
    return response.json();
  }
  async function expectInstallAction(label, disabled) {
    await until(() => js(`(() => {
      const layer = document.getElementById('capModalLayer'), button = document.getElementById('capImportDo');
      return layer && !layer.hidden && button?.textContent === ${JSON.stringify(label)} && button.disabled === ${disabled};
    })()`), 'installation action: ' + label);
  }
  async function click(selector) {
    const point = await js(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node || node.disabled) throw Error('Control unavailable');
      node.scrollIntoView({ block: 'center' });
      const bounds = node.getBoundingClientRect();
      const x = Math.round(bounds.x + bounds.width / 2), y = Math.round(bounds.y + bounds.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw Error('Control is occluded');
      return { x, y };
    })()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  }
  app.whenReady().then(async () => {
    const python = process.env.SODUWORK_TEST_PYTHON;
    if (!python) throw Error('Set SODUWORK_TEST_PYTHON to an interpreter with backend test dependencies');
    if (!process.argv[3]) await fixture.seed(app, root);
    const cwd = path.join(root, 'workspaces', skillChat);
    const relative = JSON.parse(fs.readFileSync(path.join(root, 'package-location.json'), 'utf8'));
    const packagePath = path.join(cwd, relative);
    const row = { path: packagePath, artifactId: 'created-skill', relative };
    const handle = { ref: 'live-created-skill', cwd, sessionId: skillChat, inFlight: () => false,
      outputSnapshot: () => ({ files: [row], delivery: { items: [row] } }) };
    assert.match(packagePath, /\.skill$/);
    const artifact = require('../main/conversation/artifact-runtime').snapshot(handle).items.find(item => item.path === packagePath);
    assert.equal(artifact.pluginDraft, true, 'The generated skill must expose a conversation install action');
    assert.equal(artifact.skillPackage, true, 'The indexed artifact must retain its skill type');
    history = fixture.historyFor(app, root);
    const registry = { get: ref => current?.ref === ref ? current : undefined, list: () => [] };
    require('../main/pi-session/artifact-ipc').install({ app, ipcMain, BrowserWindow, session: registry, workDir: () => root });
    require('../main/pi-session/plugin-draft').installIpc(ipcMain, registry, app);
    async function activate(id) {
      if (current?.historyPreview) await current.close();
      current = id === handle.ref ? handle : await history.open(id, { historyPreview: true, allowContinuation: true });
      assert.ok(current);
      const snapshot = current.historyPreview ? current.uiSnapshot() : {};
      if (current.historyPreview) assert.equal(snapshot.messages.length, 2);
      return js(`showDelivery(${JSON.stringify(current.ref)}, ${JSON.stringify(snapshot)})`);
    }
    const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    base = 'http://127.0.0.1:' + port;
    backend = spawn(python, ['-u', path.join(__dirname, 'fixtures/created_skill_hub.py'), String(port), root], {
      cwd: path.join(repo, 'hub-backend'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1' } });
    backend.stderr.on('data', bytes => { report.errors.push(String(bytes).slice(0, 500)); });
    await until(async () => (await fetch(base + '/healthz')).ok, 'isolated backend');
    const tokens = await (await fetch(base + '/fixture/auth')).json();
    identity = { hub: base, clientId: 'device-alice', session: tokens.alice };
    require('../main/pi-session/environment-ipc').install({ app, ipcMain, session: {}, identityOf: async () => identity,
      capabilityGrantsOf: () => [], _skillDirs: () => [], workDir: () => root, _saveConf() {}, _conf: () => ({}) });
    ipcMain.handle('created-skill-auth', () => ({ ok: true, stored: true, clientId: identity.clientId,
      session: identity.session, user: { id: 'alice' }, expiresIn: 1800 }));
    ipcMain.handle('created-skill-send', async (_event, turn) => {
      const skillTurn = require('../main/pi-session/skill-turn');
      const resolveSkills = skillTurn.resolver({ app, identity, identityOf: async () => identity, skillDirs: () => [] });
      const prepared = await skillTurn.prepare({ cwd: root, resolveSkills }, turn);
      assert.equal(prepared.ok, true, prepared.reason);
      assert.deepEqual(prepared.names, [name]);
      assert.equal(fs.readFileSync(path.join(prepared.dirs[0], 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8'));
      assert.equal(fs.readFileSync(path.join(prepared.dirs[0], 'references/rules.md'), 'utf8'), references);
      worker ||= require('../main/agent-runtime/process-session');
      const runner = await skillTurn.prepareRunner({ app, cwd: root, resolveSkills }, turn, worker);
      assert.equal(runner.ok, true, runner.reason); assert.deepEqual(runner.names, [name]);
      return { ok: true, names: prepared.names, pi: true, runner: true };
    });
    const preload = path.join(root, 'preload.cjs');
    fs.writeFileSync(preload, `const { contextBridge, ipcRenderer } = require('electron');
      contextBridge.exposeInMainWorld('soduWorkAPI', {
        deviceAuthBootstrap: () => ipcRenderer.invoke('created-skill-auth'),
        conversationSession: {
          capabilities: options => ipcRenderer.invoke('conversation-capabilities', options),
          outputs: ref => ipcRenderer.invoke('pi-session-outputs', ref),
          pluginDraft: (ref, target) => ipcRenderer.invoke('pi-session-plugin-draft', ref, target)
        }, sendFixture: turn => ipcRenderer.invoke('created-skill-send', turn)
      });`);
    win = new BrowserWindow({ show: false, width: 1280, height: 1000,
      webPreferences: { preload, offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') report.errors.push(event.message.slice(0, 600)); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (info, done) => {
      done({ cancel: !info.url.startsWith(base + '/') });
    });
    await win.loadFile(path.join(__dirname, 'fixtures/created-skill-install.html'));
    const styles = [...fs.readFileSync(path.join(client, 'desk.html'), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"/g)]
      .map(match => pathToFileURL(path.join(client, match[1])).href);
    await js(`Promise.all(${JSON.stringify(styles)}.map(href => new Promise((resolve, reject) => {
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href;
      link.onload = resolve; link.onerror = () => reject(Error('Could not load fixture stylesheet'));
      document.head.insertBefore(link, document.head.querySelector('style'));
    }))).then(() => true)`);
    await js(`window.__SODUWORK_TEST_HUB_CONFIG__ = { allowSwitch: true };
      localStorage.setItem('soduwork_work_hub_url', ${JSON.stringify(base)});
      localStorage.setItem('soduwork_work_hub_environment_v1', 'development');
      localStorage.setItem('soduwork_work_development_hub_url_v1', ${JSON.stringify(base)});
      window.User = { id: 'device-alice' }; window.fixtureMessages = []; window.petSay = text => fixtureMessages.push(text); void 0;`);
    const load = async file => js(fs.readFileSync(path.join(client, file), 'utf8') + '\nvoid 0;');
    for (const file of ['core/api-work-plugins.js', 'api.js', 'core/plugin-icon.js', 'core/connector-brand.js',
      'components/panels/skill-catalog-sync.js', 'components/panels/plugin-catalog-sync.js',
      'components/panels/plugin-catalog-format.js', 'components/panels/plugin-publication-ux.js',
      'components/panels/plugin-dependency-ux.js', 'components/panels/plugin-install-setup.js',
      'components/panels/plugin-lifecycle.js', 'components/panels/plugin-presentation.js',
      'components/panels/panels-capability-directory.js', 'components/panels/panels-capability-plugins.js',
      'components/panels/panels-capability-mcp.js', 'components/panels/connector-export.js',
      'components/panels/connector-config.js', 'components/panels/connector-auth.js',
      'components/panels/connector-editor.js', 'components/panels/connector-selection.js',
      'components/panels/connector-directory.js', 'components/panels/panels-capability-editors.js',
      'components/panels/panels-capabilities.js', 'components/panels/panels-plugin-maker-utils.js',
      'components/panels/chat-plugin-draft-placement.js', 'components/panels/chat-output-links.js']) await load(file);
    await js(`(async () => {
      await SoduWorkAPI.registerClient();
      const delivery = document.getElementById('delivery'), message = delivery.innerHTML;
      window.showDelivery = async (ref, snapshot) => {
        const files = await ChatOutputLinks.load(soduWorkAPI.conversationSession, ref, [], []);
        delivery.innerHTML = ChatOutputLinks.decorate(message, files, ref, snapshot);
        return delivery.querySelectorAll('[data-install-plugin-draft]').length;
      };
      document.getElementById('delivery').onclick = event => {
        const button = event.target.closest('[data-install-plugin-draft]');
        if (button) openConversationPluginDraft(button.dataset.pluginDraftRef, button.dataset.installPluginDraft, button);
      };
    })()`);
    assert.equal(await activate(skillChat), 1, 'A cold history view must restore the actionable skill card');
    const firstRef = current.ref;
    const firstId = await js(`document.querySelector('[data-install-plugin-draft]').dataset.installPluginDraft`);
    assert.equal(await activate(otherChat), 0, 'Switching chats must remove the former skill card');
    assert.equal(await js(`soduWorkAPI.conversationSession.pluginDraft(${JSON.stringify(firstRef)}, ${JSON.stringify(firstId)}).then(row => row.ok)`), false);
    assert.equal(await activate(skillChat), 1, 'Returning to the chat must rebuild the skill card');
    assert.notEqual(current.ref, firstRef);
    assert.equal(await js(`document.querySelector('[data-install-plugin-draft]').dataset.pluginDraftRef`), current.ref);
    report.cases.push('A second Electron process restores the skill action from SQLite and rebinds it after switching chats');
    await click('[data-install-plugin-draft]');
    await until(() => js('document.querySelector("#capModalTitle")?.textContent === "安装技能"'), 'skill installation dialog');
    await expectInstallAction('安装并启用', false);
    assert.equal((await request('/capabilities')).skills.some(item => item.name === name), false);
    fs.writeFileSync(path.join(out, 'install-skill.png'), (await win.webContents.capturePage()).toPNG());
    report.cases.push('Generated .skill exposes the production conversation action and opens Install Skill before saving');
    await click('#capImportDo');
    await until(async () => (await request('/capabilities')).skills.some(item => item.name === name && item.enabled), 'personal skill import and enable');
    await until(() => js('!document.getElementById("capImportDo") || document.getElementById("capModalLayer").hidden'), 'installation completion');
    const details = await request('/skills/' + name + '/details');
    assert.equal(details.scope, 'personal');
    assert.equal(details.fileCount, 2);
    assert.equal((await request('/capabilities', { session: tokens.bob })).skills.some(item => item.name === name), false);
    assert.equal(fs.existsSync(path.join(app.getPath('userData'), 'personal-plugins.json')), false);
    assert.equal((await request('/plugins/catalog')).items.some(item => item.key === name || item.key === 'skill-' + name), false);
    assert.equal((await mutations()).imports, 1);
    report.cases.push('Confirmation imports an enabled private skill with both files, without adding a personal or Hub plugin');
    await click('[data-install-plugin-draft]');
    await expectInstallAction('已安装并启用', true);
    assert.equal((await mutations()).imports, 1, 'Reopening an installed package must not import it again');
    fs.writeFileSync(path.join(out, 'reopened-installed-skill.png'), (await win.webContents.capturePage()).toPNG());
    report.cases.push('Reopening the conversation card recognizes the identical enabled personal skill and disables installation');
    await click('#capModalClose');
    await js('openCapabilityPanel()');
    await click('[data-cap-tab="skills"]');
    await until(() => js(`!!document.querySelector('[data-skill-details="${name}"]')`), 'installed skill in the production Skills tab');
    assert.equal(await js(`document.querySelector('[data-skill="${name}"]').getAttribute('aria-pressed')`), 'true');
    fs.writeFileSync(path.join(out, 'installed-skill.png'), (await win.webContents.capturePage()).toPNG());
    report.cases.push('The production Skills tab lists and enables the generated skill after installation');
    await click(`[data-skill="${name}"]`);
    await until(async () => (await request('/capabilities')).skills.some(item => item.name === name && !item.enabled), 'personal skill disabled');
    await click('#capClose');
    await click('[data-install-plugin-draft]');
    await expectInstallAction('已安装（未启用）', true);
    assert.equal((await mutations()).imports, 1, 'Inspecting a disabled installed skill must not enable it');
    assert.equal((await request('/skills/' + name + '/details')).checksum, details.checksum);
    fs.writeFileSync(path.join(out, 'reopened-disabled-skill.png'), (await win.webContents.capturePage()).toPNG());
    await click('#capModalClose');
    await js('openCapabilityPanel()');
    await click('[data-cap-tab="skills"]');
    await until(() => js(`document.querySelector('[data-skill="${name}"]')?.getAttribute('aria-pressed') === 'false'`), 'disabled skill in catalog');
    await click(`[data-skill="${name}"]`);
    await until(async () => (await request('/capabilities')).skills.some(item => item.name === name && item.enabled), 'installed skill re-enabled');
    await click('#capClose');
    assert.equal((await mutations()).imports, 1, 'Re-enabling an installed skill must not overwrite its package');
    assert.equal((await request('/skills/' + name + '/details')).checksum, details.checksum);
    report.cases.push('A disabled identical skill stays installed without mutations and can be re-enabled from the Skills tab');
    assert.equal(await activate(handle.ref), 1, 'The live conversation must also expose its installation action');
    references += 'Compare the result against the original before returning it.\n';
    fs.writeFileSync(path.join(source, 'references/rules.md'), references);
    const replacementDelivery = path.join(root, 'replacement-delivery');
    const replacement = require('../../skills/skill-studio/scripts/skill-package.cjs').build({
      source, out: replacementDelivery, targets: 'soduwork' });
    fs.copyFileSync(path.join(replacementDelivery, replacement.exports[0].file), packagePath);
    await click('[data-install-plugin-draft]');
    await expectInstallAction('替换并启用', false);
    assert.equal((await mutations()).imports, 1, 'A same-name changed package must await replacement confirmation');
    assert.equal((await request('/skills/' + name + '/details')).checksum, details.checksum);
    fs.writeFileSync(path.join(out, 'replacement-skill.png'), (await win.webContents.capturePage()).toPNG());
    await click('#capImportDo');
    await until(async () => (await request('/skills/' + name + '/details')).checksum !== details.checksum, 'explicit same-name replacement');
    await until(() => js('document.getElementById("capModalLayer").hidden'), 'replacement completion');
    assert.equal((await mutations()).imports, 2);
    await click('[data-install-plugin-draft]');
    await expectInstallAction('已安装并启用', true);
    assert.equal((await mutations()).imports, 2, 'Reopening the replacement must not repeat its installation');
    await click('#capModalClose');
    report.cases.push('A same-name different-checksum package requires Replace and Enable, then reopens as already installed');
    const prepared = await js(`soduWorkAPI.sendFixture({ text: 'Apply the supplied rules', skills: [${JSON.stringify(name)}] })`);
    assert.equal(prepared.pi && prepared.runner, true);
    report.cases.push('Fresh account authorization and immutable synchronization prepare the current SKILL.md and replacement reference for Pi and Runner');
    assert.equal(await activate(skillChat), 0, 'Replacing the package must invalidate the original historical installation action');
    report.cases.push('The original history receipt refuses the changed package while its live replacement remains installable');
    report.mutations = await mutations();
    assert.deepEqual(report.mutations, { imports: 2, selections: 2 });
    report.ok = true;
  }).catch(async error => {
    report.error = error.stack;
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  }).finally(async () => {
    try { await worker?.closeAll?.(); } catch {}
    await current?.close?.(); await history?.close();
    if (win && !win.isDestroyed()) win.destroy();
    if (backend && backend.exitCode === null) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/pid', String(backend.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch {}
      } else backend.kill();
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, error: report.error, report: path.join(out, 'report.json') }));
    app.exit(report.ok ? 0 : 1);
  });
}
