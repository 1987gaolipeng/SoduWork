'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Absolute evidence directory required');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const result = spawnSync(require('electron'), [path.join(__dirname, 'custom-agents.cjs'), output], {
  cwd: path.resolve(__dirname, '..'), windowsHide: true, timeout: 180000, env, encoding: 'utf8',
});
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
if (result.error) console.error(result.error.message);
process.exit(result.status == null ? 1 : result.status);
