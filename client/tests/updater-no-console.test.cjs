'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const updater = require('../main/client-updater');

test('Windows update helper is console-free and cannot wait forever', () => {
  const script = updater._updateHelperScript();
  assert.doesNotMatch(script, /tasklist|find\s|ping 127|cmd\.exe/i);
  assert.match(script, /Win32_Process/);
  assert.match(script, /For attempts = 1 To 240/);
  assert.match(script, /SELECT ProcessId, ExecutablePath FROM Win32_Process/);
  assert.match(script, /IsOwnedExecutable\(exePath, installDir, appFile\)/);
  assert.match(script, /row\.Terminate/);
  assert.match(script, /fileName = "soduwork-runner\.exe"/);
  assert.match(script, /fileName = "soduwork-runner\.exe"/);
  assert.match(script, /For attempts = 1 To 80/);
  assert.match(script, /WScript\.Sleep 500/);
  assert.match(script, /\/S --updated".*modeArg.*" \/D=/);
  assert.match(script, /SODUWORK_INSTALL_MODE.*CurrentUser.*\/currentuser/);
  assert.match(script, /SODUWORK_INSTALL_MODE.*all.*\/allusers/);

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'main', 'client-updater.js'), 'utf8');
  assert.match(source, /wscript\.exe/);
  assert.match(source, /windowsHide:\s*true/);
  assert.match(source, /SODUWORK_INSTALL_DIR:\s*installLayout\.installRoot\(\)/);
  assert.doesNotMatch(source, /install-update\.cmd|tasklist \/FI|goto wait_for_soduwork/);
});

test('update state writes degrade rename to copy on EXDEV-restricted filesystems', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'main', 'client-updater.js'), 'utf8');
  assert.match(source, /error\.code === 'EXDEV'/,
    'update state/pending writes must degrade rename to copy on EXDEV');
});
