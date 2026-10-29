// Build a reviewable local candidate without changing source version files or publishing.
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { build, Platform, Arch } = require('electron-builder');
const { prepareRunner } = require('./prepare-runner.cjs');
const client = path.resolve(__dirname, '..');
async function main(args = process.argv.slice(2), { prepare = prepareRunner } = {}) {
  const [target, version, electronZip] = args;
  if (!target || !path.isAbsolute(target) || !/^\d+\.\d+\.\d+$/.test(version || '') ||
      !electronZip || !path.isAbsolute(electronZip)) throw Error('Usage: node build-installer-candidate.cjs <new absolute work directory> <x.y.z> <cached Electron zip>');
  const root = path.resolve(target);
  const outputBase = path.join(client, 'dist');
  if (root === client || (root.startsWith(client + path.sep) && !root.startsWith(outputBase + path.sep))) {
    throw Error('Inside the client, candidates must use a new directory under dist');
  }
  // The builder API bypasses npm lifecycle hooks. Require fresh Runner bytes
  // before creating a snapshot or handing any resources to the packager.
  prepare();
  // Exclusive creation keeps a rerun from silently overwriting a previously reviewed candidate.
  await fs.mkdir(root);
  const source = path.join(root, 'source'), dist = path.join(root, 'dist');
  await fs.mkdir(source);
  const pkg = JSON.parse(await fs.readFile(path.join(client, 'package.json'), 'utf8'));
  const base = pkg.build;
  const names = [...new Set(base.files.filter(x => typeof x === 'string' && !x.startsWith('!')).map(x => x.split('/')[0]))];
  for (const name of names) await fs.cp(path.join(client, name), path.join(source, name), { recursive: true,
    filter: file => !path.relative(client, file).split(path.sep).includes('node_modules') });
  pkg.version = version;
  delete pkg.build;delete pkg.devDependencies;delete pkg.scripts;
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  await fs.writeFile(path.join(source, 'version.json'), JSON.stringify({ version }) + '\n');
  const config = { ...base, directories: { app: source, output: dist, buildResources: path.join(client, 'build') },
      // Resolve bundled resources against the real reviewed project, not the source snapshot.
      // Platform sections must be resolved too: their relative paths otherwise point at
      // the snapshot's missing runner/.runtime directories.
      extraResources: base.extraResources.map(item => ({ ...item, from: path.resolve(client, item.from) })),
      win: base.win && { ...base.win, extraResources: (base.win.extraResources || []).map(item => ({ ...item, from: path.resolve(client, item.from) })) },
      mac: base.mac && { ...base.mac, extraResources: (base.mac.extraResources || []).map(item => ({ ...item, from: path.resolve(client, item.from) })) },
      electronVersion: require('electron/package.json').version, electronDist: electronZip,
      npmRebuild: false, afterPack: path.join(client, 'scripts/prepare-installer.cjs'), afterSign: path.join(client, 'scripts/prepare-installer.cjs'), publish: null,
      nsis: { ...base.nsis, artifactName: 'SoduWork-' + version + '-InstallerFix-Preview.exe',
        include: path.join(client, 'build/installer.nsh'), installerIcon: path.join(client, 'icon.ico'),
        uninstallerIcon: path.join(client, 'icon.ico'), runAfterFinish: false },
    };
  // An explicit config file avoids merging duplicate resource arrays with package.json.
  const configFile = path.join(root, 'electron-builder.json');
  await fs.writeFile(configFile, JSON.stringify(config, null, 2));
  const paths = await build({ projectDir: client, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config: configFile });
  const installer = paths.find(file => file.endsWith('.exe'));
  if (!installer || !installer.startsWith(dist + path.sep)) throw Error('Missing candidate installer');
  const hash = crypto.createHash('sha256');let bytes = 0;
  for await (const chunk of require('node:fs').createReadStream(installer)) { bytes += chunk.length;hash.update(chunk); }
  const result = { version, source, installer, unpacked: path.join(dist, 'win-unpacked'), bytes,
    sha256: hash.digest('hex'), payloadVerified: false, published: false, channel: 'local-customer-retest', sourceVersion: JSON.parse(await fs.readFile(path.join(client, 'version.json'), 'utf8')).version };
  await fs.writeFile(path.join(root, 'candidate.json'), JSON.stringify(result, null, 2));
  const checked = require('node:child_process').spawnSync(process.execPath, [path.join(client, 'e2e/installer-candidate-payload.cjs'), path.join(root, 'candidate.json')],
    { stdio: 'inherit', windowsHide: true, timeout: 600000 });
  if (checked.status !== 0) throw Error('Candidate payload verification failed; do not distribute this installer');
  console.log(JSON.stringify({ ...result, payloadVerified: true }));
}
if (require.main === module) {
  let finished = false;
  process.once('beforeExit', () => { if (!finished) { console.error('Candidate build ended without a verified result');process.exitCode = 1; } });
  main().then(() => { finished = true; }, error => { finished = true;console.error(error);process.exitCode = 1; });
}
module.exports = { main };
