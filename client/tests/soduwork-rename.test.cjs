'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pkg = require('../package.json');
const { INSTALLER_NAMES } = require('../main/client-update-contract');
const { UUID } = require('builder-util-runtime');
const { getWindowsInstallationDirName } = require('app-builder-lib/out/targets/targetUtil');

test('Windows installation has independent registration and defaults to SoduWork', () => {
  const namespace = UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3');
  // Keep the installation identity stable across releases without deriving it
  // from the current appId again (the constant predates the app id rename).
  assert.equal(pkg.build.nsis.guid, '35643c48-76d7-54ae-9c89-cc281f9a86a4');
  assert.notEqual(pkg.build.nsis.guid, UUID.v5('com.otherlegacy.app', namespace));
  assert.equal(getWindowsInstallationDirName({
    productFilename: pkg.build.productName, sanitizedName: pkg.name,
  }, !pkg.build.nsis.oneClick), 'SoduWork');
});

test('new brand keeps installed identity while producing new artifact names', () => {
  assert.equal(pkg.productName, 'SoduWork');
  assert.equal(pkg.build.productName, 'SoduWork');
  assert.equal(pkg.build.appId, 'com.soduwork.app');
  assert.equal(pkg.build.win.executableName || pkg.build.productName, 'SoduWork');
  assert.equal(pkg.build.linux.executableName, 'soduwork');
  assert.equal(pkg.author, 'SoduWork');
  assert.match(pkg.build.linux.maintainer, /^SoduWork </);
  for (const target of ['nsis', 'mac', 'linux']) assert.match(pkg.build[target].artifactName, /^SoduWork-/);
  for (const brand of ['SoduWork']) {
    for (const [platform, suffix] of [['win32', 'Setup.exe'], ['darwin', 'mac-arm64.dmg'], ['linux', 'linux.deb']]) {
      assert.ok(INSTALLER_NAMES[platform].test(`${brand}-1.12.80-${suffix}`));
      assert.ok(!INSTALLER_NAMES[platform].test(`../${brand}-1.12.80-${suffix}`));
    }
  }
});

// Check display branding only; installer, mutex, protocol, and storage identifiers keep their own contracts.
const oldDisplayName = new RegExp(['\\b', ['B','u','b'].join(''), 'ly(?![A-Za-z])'].join(''));
test('native updater and installer display strings use the current product name', () => {
  const build = path.join(__dirname, '../build');
  for (const file of fs.readdirSync(build).filter(name => /\.(?:nsi|nsh)$/.test(name))) {
    const source = fs.readFileSync(path.join(build, file), 'utf8');
    const displayed = source.split(/\r?\n/).filter(line =>
      /^\s*(?:Name |Caption |MessageBox |StrCpy \$0 |SendMessage \$HWNDPARENT \$\{WM_SETTEXT\})/.test(line));
    for (const line of displayed) assert.doesNotMatch(line, oldDisplayName, `${file}: ${line}`);
  }
  const launcher = fs.readFileSync(path.join(build, 'launcher.nsi'), 'utf8');
  const progress = fs.readFileSync(path.join(build, 'launcher-progress.nsh'), 'utf8');
  assert.match(launcher, /Caption "SoduWork 正在更新"/);
  assert.match(progress, /STR:SoduWork is updating/);
  assert.match(progress, /正在更新 SoduWork/);
  assert.match(progress, /Updating SoduWork/);
});

test('all shipped translations and bundled agent descriptions avoid old display names', () => {
  const dir = path.join(__dirname, '../core/locales');
  const manifest = require('../core/locales/manifest.json');
  for (const file of manifest.filter(name => /^[a-z]{2}-[A-Z]{2}(?:-|\.)/.test(name))) {
    for (const [key, value] of Object.entries(require(path.join(dir, file)))) {
      assert.doesNotMatch(value, oldDisplayName, `${file}: ${key}`);
    }
  }
  const catalog = require('../../hub-backend/app/agent_catalog.json');
  assert.doesNotMatch(JSON.stringify(catalog), oldDisplayName);
});

test('the actual sign-out prompt resolves to SoduWork in every supported language', () => {
  const source = fs.readFileSync(path.join(__dirname, '../components/client-auth/client-auth.js'), 'utf8');
  const literal = source.match(/translateText \|\| String\)\(('(?:\\.|[^'\\])*')\)/)[1];
  const prompt = vm.runInNewContext(literal);
  const native = require('../main/native-locale.cjs');
  try {
    for (const language of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
      native.setLocale(language);
      const displayed = native.translate(prompt);
      assert.match(displayed, /SoduWork/);
      assert.doesNotMatch(displayed, oldDisplayName);
      if (language !== 'zh-CN') assert.notEqual(displayed, prompt, language);
    }
  } finally { native.setLocale('zh-CN'); }
});
