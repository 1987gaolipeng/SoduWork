'use strict';
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' })
    .on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app } = electron, fs = require('node:fs/promises'), path = require('node:path');
  const os = require('node:os'), assert = require('node:assert/strict');
  const report = { ok: false, boundary: 'Real Electron ASAR worker; isolated compressed Skill files, no user account or model' };
  const root = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-asar-'));
  app.setPath('userData', path.join(root, 'profile'));
  app.setPath('sessionData', path.join(root, 'session'));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function measure(action) {
    let tick = performance.now(), lag = 0, ticks = 0; const start = tick;
    const timer = setInterval(() => { const now = performance.now(); lag = Math.max(lag, now - tick - 5); tick = now; ticks++; }, 5);
    try { await action(); await delay(15); }
    finally { clearInterval(timer); }
    return { totalMs: Math.round(performance.now() - start), maxMainLoopLagMs: Math.round(lag), ticks };
  }
  app.whenReady().then(async () => {
    const source = path.join(root, 'source');
    for (const file of ['conversation/skill-cache.js', 'conversation/skill-cache-worker.js',
      'conversation/skill-frontmatter.js', 'pi-session/session-helpers.js',
      'device-auth-request.js', 'pi-session/device-auth-request.js']) {
      const target = path.join(source, file); await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.resolve(__dirname, '../main', file), target);
    }
    const archive = path.join(root, 'app.asar'); await require('@electron/asar').createPackage(source, archive);
    const body = Buffer.alloc(128 * 1024, 65), files = [
      { name: 'manifest.json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, skills: [{ name: 'fixture', dir: 'fixture', version: 'v1' }] })) },
      { name: 'skills/fixture/SKILL.md', bytes: Buffer.from('---\nname: fixture\ndescription: Isolated fixture\n---\n') },
      ...Array.from({ length: 200 }, (_, i) => ({ name: 'skills/fixture/files/' + i + '.txt', bytes: body })),
    ];
    const bytes = await require('../main/conversation/zip-archive').createEntries(files);
    const packagedCache = require(path.join(archive, 'conversation/skill-cache.js'));
    const skillRuntimeEntry = require('../main/pi-session/session-helpers')
      .entryCandidates().find(require('node:fs').existsSync);
    assert.ok(skillRuntimeEntry, 'Use the installed conversation runtime for Skill validation');
    const checksum = packagedCache._digest(bytes);
    report.files = files.length; report.unpackedBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
    report.synchronous = await measure(() => packagedCache.install({ getPath: () => path.join(root, 'baseline'), skillRuntimeEntry }, bytes, checksum));
    const targetApp = { getPath: () => path.join(root, 'background'), skillRuntimeEntry }; let result;
    report.background = await measure(async () => { result = await require(path.join(archive, 'conversation/skill-cache-worker.js')).install(targetApp, bytes, checksum); });
    assert.equal(result[0].bundleChecksum, checksum);
    for (const i of [0, 99, 199]) assert.deepEqual(await fs.readFile(path.join(result[0].path, 'files', i + '.txt')), body);
    await assert.rejects(require(path.join(archive, 'conversation/skill-cache-worker.js')).install(targetApp, bytes, '0'.repeat(64)), /完整性/);
    assert.deepEqual(await require(path.join(archive, 'conversation/skill-cache-worker.js')).install(targetApp, bytes, checksum), result);
    assert.ok(report.background.maxMainLoopLagMs < 300); report.ok = true;
  }).catch(error => { report.error = error.stack; }).finally(async () => {
    const out = path.resolve(__dirname, '../../outputs/first-send-startup-20261004/skill-asar.json');
    await fs.mkdir(path.dirname(out), { recursive: true }); await fs.writeFile(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    // Windows may retain the ASAR descriptor until Electron exits.
    if (root && path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('soduwork-skill-asar-'))
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }).catch(() => {});
    app.exit(report.ok ? 0 : 1);
  });
}
