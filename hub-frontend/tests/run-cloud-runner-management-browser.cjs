const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
const child = spawn(require('../../client/node_modules/electron'),
  [path.join(__dirname, 'cloud-runner-management-browser.cjs')],
  { env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
let finished = false
function finish(code) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  try {
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') {
        const stopped = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore', timeout: 15000 })
        if (stopped.error) throw stopped.error
        if (stopped.status !== 0) {
          let exited = false
          try { process.kill(child.pid, 0) } catch (error) {
            if (error.code !== 'ESRCH') throw error
            exited = true
          }
          if (stopped.status !== 128 || !exited) throw Error('Electron fixture cleanup failed: taskkill exit ' + stopped.status)
        }
      } else if (!child.kill()) throw Error('Electron fixture cleanup failed')
    }
  } catch (error) { console.error(error); code = 1 }
  if (child.connected) child.disconnect()
  process.exitCode = code
  return code
}
const timer = setTimeout(() => {
  console.error('Cloud runner management browser verification timed out')
  finish(1)
}, 180000)
child.once('message', message => {
  if (message?.type !== 'soduwork-cloud-runner-admin-complete' || typeof message.result?.ok !== 'boolean') return
  const code = finish(message.result.ok ? 0 : 1)
  console.log(JSON.stringify({ ok: code === 0, managedElectronShutdown: true }))
})
child.once('error', error => { console.error(error); finish(1) })
child.once('exit', code => {
  if (!finished) {
    console.error('Electron fixture exited before its live completion signal: ' + code)
    finish(1)
  }
})
