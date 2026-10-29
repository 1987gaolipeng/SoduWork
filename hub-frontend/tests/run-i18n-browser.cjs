const path = require('node:path')
const { spawnSync } = require('node:child_process')
const electron = process.env.SODUWORK_ADMIN_TEST_ELECTRON || require('../../client/node_modules/electron')
const env = { ...process.env }
for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[name]
const result = spawnSync(electron, [path.join(__dirname, 'i18n-browser.cjs')], { env, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
console.log(result.stdout)
if (result.status !== 0) console.error(result.stderr || result.error)
process.exitCode = result.status || (result.error ? 1 : 0)
