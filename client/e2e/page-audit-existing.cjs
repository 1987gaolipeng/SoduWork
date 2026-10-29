'use strict';
// Wrap older UI specs that do not all set userData themselves. Each execution
// owns a temporary Electron profile and blocks non-loopback renderer requests.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const electron = require('electron');
const specs = ['model-settings', 'model-page-loading', 'cloud-environments-personal',
  'custom-agents', 'archive-history', 'session-memory-personal', 'session-memory-import',
  'schedule-card-actions', 'ai-team-empty', 'requirements-board'];
if (typeof electron === 'string') {
  const {spawnSync} = require('node:child_process');
  const env = {...process.env};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
  const out = path.resolve(process.argv[2] || path.join(__dirname, '../../outputs/page-audit-existing-20261014'));
  fs.mkdirSync(out, {recursive: true});
  const report = {ok: true, scope: 'Isolated UI, selected real IPC and synthetic services; no live Hub/model', results: []};
  for (const name of specs) {
    const output = path.join(out, name); fs.mkdirSync(output, {recursive: true});
    const started = Date.now();
    const result = spawnSync(electron, [__filename, '--wrapped-spec=' + name, output],
      {env, cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024});
    fs.writeFileSync(path.join(output, 'run.log'), (result.stdout || '') + (result.stderr || '') + (result.error?.stack || ''));
    const row = {name, exitCode: result.status, ok: result.status === 0, elapsedMs: Date.now() - started};
    report.results.push(row); report.ok &&= row.ok; console.log(JSON.stringify(row));
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
  process.exitCode = report.ok ? 0 : 1;
} else {
  const name = process.argv.find(arg => arg.startsWith('--wrapped-spec='))?.slice(15);
  if (!specs.includes(name)) throw Error('Unknown isolated spec');
  const output = process.argv.at(-1);
  if (!path.isAbsolute(output)) throw Error('Absolute output required');
  electron.app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-page-' + name + '-')));
  electron.app.on('session-created', sess => {
    sess.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']}, (request, done) => {
      const host = new URL(request.url).hostname;
      done({cancel: !['127.0.0.1', 'localhost', '[::1]'].includes(host)});
    });
  });
  process.argv = [process.argv[0], path.join(__dirname, name + '.cjs'), output];
  require('./' + name + '.cjs');
}
