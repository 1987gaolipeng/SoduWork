'use strict';
// Build a tiny isolated application using the production Windows icon configuration.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const builder = require('electron-builder');
const client = path.join(__dirname, '..');
const output = process.argv[2];
assert.ok(output && path.isAbsolute(output)); assert.equal(process.platform, 'win32');
const project = path.join(output, 'project'); fs.mkdirSync(project, { recursive: true });
for (const [source, target] of [['e2e/native-app-icon.cjs', 'main.cjs'], ['e2e/native-app-icon.ps1', 'native-app-icon.ps1'],
  ['main/native-app-icon.cjs', 'native-app-icon.cjs'], ['icon.ico', 'icon.ico']]) fs.copyFileSync(path.join(client, source), path.join(project, target));
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'soduwork-icon-fixture', version: '1.0.0', main: 'main.cjs',
  description: 'Isolated native icon verification', author: 'SoduWork', license: 'MIT' }));
const win = require('../package.json').build.win;
const config = { appId: 'com.soduwork.e2e.icons', productName: 'SoduWorkIconFixture', electronVersion: require('electron/package.json').version,
  electronDist: path.join(client, 'node_modules/electron/dist'), directories: { output: path.join(output, 'dist'), buildResources: project },
  files: ['*.cjs', '*.ico', '*.ps1'], win: { icon: win.icon, signExecutable: false, signAndEditExecutable: win.signAndEditExecutable }, asar: true, npmRebuild: false };
const configPath = path.join(project, 'builder.json'); fs.writeFileSync(configPath, JSON.stringify(config));
builder.build({ projectDir: project, config: configPath, targets: builder.Platform.WINDOWS.createTarget('dir', builder.Arch.x64) }).then(() => {
  const executable = path.join(output, 'dist/win-unpacked/SoduWorkIconFixture.exe');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = spawnSync(executable, [path.join(output, 'packaged')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || ''); assert.equal(child.status, 0, child.error?.message);
}).catch(error => { console.error(error); process.exitCode = 1; });
