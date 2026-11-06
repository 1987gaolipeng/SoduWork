'use strict';
// Real Windows HWND properties, shortcut files and icon pixels in an isolated profile.
const { app, BrowserWindow, shell, nativeImage } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const output = process.argv[app.isPackaged ? 1 : 2];
assert.ok(output && path.isAbsolute(output), 'An absolute isolated evidence directory is required');
assert.equal(process.platform, 'win32');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.setPath('appData', path.join(output, 'appData'));
const packagedHelper = path.join(__dirname, 'native-app-icon.cjs');
const fixture = app.isPackaged;
const create = require(fixture ? packagedHelper : '../main/native-app-icon.cjs').create;
const root = fixture ? __dirname : path.join(__dirname, '..');
const helper = create({ app, shell, root, profile: { appId: 'com.soduwork.e2e.icons', productName: 'SoduWork Icon Fixture' }, launchPath: candidate => candidate || process.execPath });
helper.install();
app.whenReady().then(async () => {
  const report = { ok: false, packaged: fixture };
  let win;
  try {
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    const handle = win.getNativeWindowHandle().readBigUInt64LE().toString();
    // PowerShell needs a real script file when this entry is running from an ASAR.
    const script = path.join(output, 'probe.ps1');
    fs.copyFileSync(path.join(__dirname, 'native-app-icon.ps1'), script);
    report.properties = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, '-WindowHandle', handle,
        '-OutputFile', path.join(output, 'window-icon.png'), '-Executable', process.execPath], { windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('close', code => code ? reject(Error(stderr)) : resolve(JSON.parse(stdout)));
    });
    assert.equal(report.properties.icon, helper.icon() + ',0');
    assert.match(report.properties.appId, fixture ? /^com\.soduwork\.e2e\.icons$/ : /^com\.soduwork\.e2e\.icons\.dev\./);
    const rendered = nativeImage.createFromPath(path.join(output, 'window-icon.png'));
    const size = rendered.getSize();
    const expected = nativeImage.createFromPath(helper.icon()).resize(size).toBitmap();
    const actual = rendered.toBitmap();
    let delta = 0;
    for (let i = 0; i < expected.length; i++) delta += Math.abs(actual[i] - expected[i]);
    report.pixelDifference = delta / expected.length;
    assert.ok(report.pixelDifference < 12, 'Native window must carry the product icon pixels');
    if (fixture) {
      const directory = path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
      fs.mkdirSync(directory, { recursive: true });
      const own = path.join(directory, 'own.lnk'), foreign = path.join(directory, 'foreign.lnk');
      assert.ok(shell.writeShortcutLink(own, { target: process.execPath, args: '--preserve', icon: process.execPath, iconIndex: 0 }));
      assert.ok(shell.writeShortcutLink(foreign, { target: process.env.ComSpec, icon: process.env.ComSpec, iconIndex: 0 }));
      const before = fs.readFileSync(foreign);
      helper.repairPins();
      const details = shell.readShortcutLink(own);
      assert.equal(details.icon, helper.icon()); assert.equal(details.args, '--preserve'); assert.equal(details.target, process.execPath);
      assert.equal(details.appUserModelId, 'com.soduwork.e2e.icons');
      assert.deepEqual(fs.readFileSync(foreign), before);
      const executableIcon = nativeImage.createFromPath(path.join(output, 'executable-icon.png'));
      const expectedExe = nativeImage.createFromPath(helper.icon()).resize(executableIcon.getSize()).toBitmap();
      const actualExe = executableIcon.toBitmap();
      let exeDelta = 0;
      for (let i = 0; i < expectedExe.length; i++) exeDelta += Math.abs(actualExe[i] - expectedExe[i]);
      report.executablePixelDifference = exeDelta / expectedExe.length;
      assert.ok(report.executablePixelDifference < 12, 'Packaged executable must contain the product icon');
      report.shortcutRepair = true;
    }
    report.ok = true;
  } catch (error) { report.error = error.stack; }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (win) win.destroy();
  console.log(JSON.stringify(report)); app.exit(report.ok ? 0 : 1);
});
