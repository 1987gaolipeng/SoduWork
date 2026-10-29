const path=require('node:path'),{spawnSync}=require('node:child_process'),electron=require('../../client/node_modules/electron')
const env={...process.env};for(const k of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','CHROME_CRASHPAD_PIPE_NAME','CHROME_CRASHPAD_PIPE_HANDLE'])delete env[k]
const result=spawnSync(electron,[path.join(__dirname,'model-capabilities-browser.cjs')],{env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:2*1024*1024})
console.log(result.stdout);if(result.status!==0)console.error(result.stderr||result.error);process.exitCode=result.status||(result.error?1:0)
