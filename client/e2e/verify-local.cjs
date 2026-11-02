'use strict';
// Deterministic local journeys; never enrolls a real user or calls a paid model.
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const client = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(client, '../outputs/local-e2e'));
fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, PYTHONUTF8: '1' };
for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME',
  'CHROME_CRASHPAD_PIPE_HANDLE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_DEVEL_SANDBOX']) delete env[key];
const electron = require('electron');
const specs = [
  ['hub-connection', process.execPath, ['e2e/hub-connection.cjs']],
  ['cloud-handoff-dialog', electron, ['e2e/cloud-handoff.cjs', path.join(output, 'cloud-handoff-dialog')]],
  ['cloud-handoff-integration', electron, ['e2e/cloud-handoff-integration.cjs', path.join(output, 'cloud-handoff-integration')]],
  ['cloud-environments-personal', electron, ['e2e/cloud-environments-personal.cjs', path.join(output, 'cloud-environments-personal')]],
  ['cloud-start-compose', electron, ['e2e/cloud-start-compose.cjs', path.join(output, 'cloud-start-compose')]],
  ['portable-workspace-asar', electron, ['e2e/portable-workspace-asar.cjs', path.join(output, 'portable-workspace-asar.json')]],
  ['access-controls', electron, ['e2e/access-controls.cjs']],
  ['memory-http', process.execPath, ['e2e/session-memory-http.cjs', path.join(output, 'memory-http')]],
  ['memory-panel', electron, ['e2e/session-memory-import.cjs']],
  ['brand-bridge', electron, ['e2e/soduwork-brand-clean.cjs']],
  ['long-conversation', electron, ['e2e/long-conversation.cjs']],
  ['chat-stream-scroll', process.execPath, ['e2e/chat-stream-scroll.cjs']],
  ['chat-stream-stability', process.execPath, ['e2e/chat-stream-stability.cjs']],
  ['platform-connections', electron, ['e2e/platform-connections.cjs', path.join(output, 'platform-connections')]],
  ['plugin-authoring', process.execPath, ['e2e/plugin-authoring.mjs', path.join(output, 'plugin-authoring')]],
  ['plugin-resources', process.execPath, ['e2e/plugin-resources.mjs', path.join(output, 'plugin-resources')]],
  ['plugin-roundtrip', process.execPath, ['--test', 'e2e/plugin-export-roundtrip.cjs', 'tests/soduwork-brand-clean.test.cjs']],
];
const results = [];
for (const [name, executable, args] of specs) {
  const start = Date.now();
  const result = spawnSync(executable, args, { cwd: client, env, encoding: 'utf8',
    windowsHide: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
  const log = (result.stdout || '') + (result.stderr || '') + (result.error ? '\n' + result.error.stack : '');
  fs.writeFileSync(path.join(output, name + '.log'), log);
  const completed = name === 'plugin-roundtrip' || /"ok"\s*:\s*true/.test(result.stdout || '');
  const row = { name, ok: result.status === 0 && completed, exitCode: result.status,
    durationMs: Date.now() - start, completionReceipt: completed };
  results.push(row);
  console.log(JSON.stringify(row));
}
const report = { ok: results.every(row => row.ok), scope: 'Local isolated integration and Electron journeys', results };
fs.writeFileSync(path.join(output, 'local-report.json'), JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
