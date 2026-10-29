// Validate the full delivered NSIS payload without installing its production appId.
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
async function main() {
  const candidateFile = process.argv[2];
  assert.ok(candidateFile && path.isAbsolute(candidateFile));
  const work = path.resolve(path.dirname(candidateFile)), candidate = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
  const installer = path.resolve(candidate.installer);
  assert.ok(installer.startsWith(work + path.sep));
  const bytes = fs.readFileSync(installer);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), candidate.sha256);
  const os = require('node:os');
  const checkId = crypto.randomUUID();
  const root = path.join(os.tmpdir(), 'soduwork-package-check-' + checkId);
  assert.equal(fs.existsSync(root), false);
  const envCheck = { ...process.env }; delete envCheck.ELECTRON_RUN_AS_NODE;
  const invalid = spawnSync(installer, ['/S', '/SODUWORK-PACKAGE-CHECK=' + path.join(work, 'invalid-output')], {env: envCheck, windowsHide: true, timeout: 30000});
  assert.equal(invalid.status, 87); assert.equal(fs.existsSync(path.join(work, 'invalid-output')), false);
  const extractionStarted = Date.now();
  const extraction = spawnSync(installer, ['/S', '/SODUWORK-PACKAGE-CHECK=' + checkId], {
    env: envCheck, encoding: 'utf8', windowsHide: true, timeout: 600000,
  });
  const nativeExtractionMs = Date.now() - extractionStarted;
  assert.equal(extraction.status, 0, extraction.stderr || extraction.error?.message || 'Native package self-check failed');
  assert.equal(fs.existsSync(path.join(root, '.soduwork-active')), false);
  const originalInventory = fs.readFileSync(path.join(root, '.soduwork-payload.json'));
  const existing = spawnSync(installer, ['/S', '/SODUWORK-PACKAGE-CHECK=' + checkId], {env:envCheck, windowsHide:true, timeout:30000});
  assert.equal(existing.status, 183); assert.deepEqual(fs.readFileSync(path.join(root, '.soduwork-payload.json')), originalInventory);
  const verifier = path.join(root, '.soduwork-verify.cjs');
  assert.deepEqual(fs.readFileSync(verifier), fs.readFileSync(path.resolve(__dirname, '../build/verify-payload.cjs')), 'Delivered verifier is the corrected source');
  const report = path.join(work, 'full-payload-verification.json');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const checked = spawnSync(path.join(root, 'SoduWork.exe'), [verifier, root, report], { env, encoding: 'utf8', windowsHide: true, timeout: 300000 });
  assert.equal(checked.status, 0, checked.stderr || checked.error?.message);
  const details = JSON.parse(fs.readFileSync(report, 'utf8'));assert.equal(details.ok, true);
  const appArchive = path.join(root, 'resources/app.asar');
  assert.equal(JSON.parse(asar.extractFile(appArchive, 'package.json')).version, candidate.version);
  assert.equal(JSON.parse(asar.extractFile(appArchive, 'version.json')).version, candidate.version);
  // Also prove that the snapshot really contains the recent platform-session/Feishu fixes.
  for (const name of ['main/platform-connections/runtime.cjs', 'main/platform-connections/feishu-auth.cjs']) {
    assert.deepEqual(asar.extractFile(appArchive, path.normalize(name)), fs.readFileSync(path.join(candidate.source, name)));
  }
  // Custom Electron ZIP distributions retain upstream's LICENSE name. Both names
  // are fully inventoried; the bytes must be identical to Electron's original license.
  const licenseName = fs.existsSync(path.join(root, 'LICENSE.electron.txt')) ? 'LICENSE.electron.txt' : 'LICENSE';
  const license = fs.readFileSync(path.join(root, licenseName));
  assert.equal(crypto.createHash('sha256').update(license).digest('hex'), '5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d');
  const result = { ...candidate, payloadVerified: true, extracted: root, extractionMethod: 'native-nsis', nativeExtractionMs,
    deliveredVerifierMatches: true, versionsConsistent: true, fileCount: details.fileCount,
    licenseName, licenseBytes: license.length, licenseSha256: crypto.createHash('sha256').update(license).digest('hex'),
    validation: 'Actual EXE native self-check before install initialization; every file verified; no production registry/shortcuts/activation' };
  fs.writeFileSync(candidateFile, JSON.stringify({ ...candidate, payloadVerified: true }, null, 2));
  fs.writeFileSync(path.join(work, 'payload-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: true, version: candidate.version, fileCount: details.fileCount, sha256: candidate.sha256 }));
}
main().catch(error => { console.error(error);process.exitCode = 1; });
