'use strict';
// A separate WinForms application, real desktop windows and OS input. No model,
// installation, user window, or SoduWork profile is used by this fixture.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, globalShortcut, screen } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-desktop-native-'));
  const output = path.resolve(process.argv[2] || path.join(__dirname, '../../outputs/computer-use-native/report.json'));
  const report = { ok: false, cases: [], isolatedExternalApplication: true, realModel: false };
  let fixture, overlay, nativeError = '', nextId = 0, cancellations = 0;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(read, label, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await read(); if (value) return value; await delay(40); }
    throw Error('Timed out: ' + label + '; fixture: ' + nativeError);
  }
  const json = name => { try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
  async function command(action, values = {}) {
    const id = ++nextId, file = path.join(root, 'request.json');
    fs.writeFileSync(file + '.next', JSON.stringify({ id, action, ...values })); fs.renameSync(file + '.next', file);
    const result = await until(() => json('response-' + id + '.json'), 'native ' + action);
    assert.equal(result.error, undefined, result.error); return result;
  }
  const handles = () => overlay.windows().map(win => ({
    handle: win.getNativeWindowHandle().readBigUInt64LE().toString(), electronBounds: win.getBounds(),
  }));
  app.setPath('userData', path.join(root, 'profile'));
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    assert.equal(process.platform, 'win32');
    const source = fs.readFileSync(path.join(__dirname, 'computer-use-native.ps1'), 'utf8');
    const script = path.join(root, 'fixture.ps1'); fs.writeFileSync(script, '\uFEFF' + source);
    fixture = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-FixtureRoot', root],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    fixture.stderr.on('data', bytes => { nativeError += bytes; });
    const ready = await until(() => json('ready.json'), 'independent WinForms application');
    report.fixturePid = ready.pid;
    report.displays = screen.getAllDisplays().map(display => ({ id: display.id, bounds: display.bounds,
      workArea: display.workArea, scaleFactor: display.scaleFactor,
      physicalBounds: screen.dipToScreenRect(null, display.bounds) }));
    await command('focus');
    overlay = require('../main/computer-use/overlay.cjs').create({ BrowserWindow, screen, ipcMain, globalShortcut,
      onCancel: () => { cancellations++; overlay.hide(); } });
    await overlay.show(); await delay(200);
    assert.equal(overlay.windows().length, report.displays.length);
    report.electronWindows = handles();
    const inspect = await command('inspect', { overlays: report.electronWindows }); report.native = inspect;
    assert.equal(inspect.foregroundIsFixture, true, 'showInactive must not steal focus');
    assert.equal(inspect.fixtureVisible, true, 'the independent app must actually be visible');
    for (let i = 0; i < inspect.overlays.length; i++) {
      const row = inspect.overlays[i], display = report.displays[i];
      const b = row.bounds, m = row.monitor, rounding = Math.ceil(display.scaleFactor);
      assert.ok(b.x <= m.x && b.y <= m.y && b.x + b.width >= m.x + m.width && b.y + b.height >= m.y + m.height,
        'native bounds must cover the complete physical display: ' + JSON.stringify({ actual: b, monitor: m }));
      assert.ok(Math.abs(b.x - m.x) <= rounding && Math.abs(b.y - m.y) <= rounding &&
        Math.abs(b.width - m.width) <= rounding && Math.abs(b.height - m.height) <= rounding, 'only DIP rounding may extend past monitor');
      assert.equal(row.visible, true); assert.equal(row.topmost, true);
      assert.equal(row.noActivate, true); assert.equal(row.transparent, true);
      assert.ok(row.order >= 0 && row.order < inspect.fixtureOrder, 'overlay stays above independent app');
    }
    report.cases.push('Real physical display bounds/DPI, independent foreground application, topmost + no-activate + mouse transparency');
    const clicked = await command('click');
    await until(async () => (await command('state')).clicks === clicked.before + 1, 'actual mouse click reaches foreign process');
    report.cases.push('OS mouse click passes through overlay into another process without focus theft');
    await command('focus');
    const focused = await command('inspect', { overlays: handles() });
    assert.equal(focused.foregroundIsFixture, true);
    assert.ok(focused.overlays.every(row => row.order >= 0 && row.order < focused.fixtureOrder));
    report.cases.push('Activating the external application keeps full-desktop indicator above it');
    await command('escape');
    await until(() => cancellations === 1 && overlay.windows().length === 0, 'actual OS Escape cancels');
    assert.equal(globalShortcut.isRegistered('Escape'), false);
    report.cases.push('OS Escape reaches real globalShortcut, hides windows and unregisters the cancellation key');
    await command('escape');
    await until(async () => (await command('state')).escapes >= 1, 'Escape returned to fixture');
    assert.equal(cancellations, 1);
    report.cases.push('After cancellation Escape belongs to the foreground application again');
    await overlay.show(); overlay.hide();
    assert.equal(globalShortcut.isRegistered('Escape'), false);
    assert.equal(overlay.windows().length, 0);
    report.cases.push('A later control scope can recreate and clean up native windows and global hotkey');
    report.hardwareBoundary = report.displays.length > 1 ? 'All attached displays measured; no monitor reconfiguration.'
      : 'One physical display; multi-display/mixed-DPI remain covered by separate geometry fixtures only.';
    report.ok = true;
  }).catch(error => { report.error = error.stack || String(error); })
    .finally(async () => {
      overlay?.dispose();
      if (fixture && fixture.exitCode === null) {
        try { await command('exit'); await until(() => fixture.exitCode !== null, 'fixture exit', 3000); }
        catch { fixture.kill(); }
      }
      report.fixtureStderr = nativeError;
      fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, report: output, error: report.error }));
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
      app.exit(report.ok ? 0 : 1);
    });
}
