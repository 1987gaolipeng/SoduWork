'use strict';
// This regression deliberately runs the real worker from an Electron ASAR.
// Plain Node/source-mode tests cannot prove packaged worker resolution works.
const { app } = require('electron');
require('./lib/isolated-profile.cjs').isolateProfile(app, 'portable-workspace-asar');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const output = path.resolve(process.argv[2] || '../outputs/portable-asar-report.json');
const report = { ok: false };
let root;
app.whenReady().then(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-asar-worker-'));
  const bundle = path.join(root, 'source'), cwd = path.join(root, 'workspace');
  await fs.mkdir(bundle); await fs.mkdir(cwd);
  for (const name of ['portable-workspace-worker.js', 'portable-workspace.js', 'zip-archive.js']) {
    await fs.copyFile(path.join(__dirname, '../main/conversation', name), path.join(bundle, name));
  }
  const archive = path.join(root, 'app.asar');
  await require('@electron/asar').createPackage(bundle, archive);
  await fs.writeFile(path.join(cwd, 'report.md'), '# Preserved report\n');
  const worker = require(path.join(archive, 'portable-workspace-worker.js'));
  const scanned = await worker.scan(cwd), snapshot = await worker.create(cwd, { sessionId: 'packaged',
    adapterId: 'pi', messages: [{ role: 'user', text: 'Continue this report' }] });
  if (scanned.files.length !== 1 || !Buffer.isBuffer(snapshot.bytes) || snapshot.manifest.files.length !== 1) {
    throw Error('Packaged worker did not return the complete workspace');
  }
  Object.assign(report, { ok: true, bytes: snapshot.bytes.length, sha256: snapshot.sha256 });
}).catch(error => { report.error = error.stack; }).finally(async () => {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  // Electron keeps an archive descriptor until exit on Windows. A cleanup
  // failure must not leave a hidden test application alive after reporting.
  if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  app.exit(report.ok ? 0 : 1);
});
